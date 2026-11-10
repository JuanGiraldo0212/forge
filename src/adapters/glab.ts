/**
 * GitLab through the GitLab CLI (glab): the same REST v4 calls and JSON as gitlab.ts, signed with glab's login
 * on the machine forge runs on (the SSH host when the app is connected to one). Forge stores no token.
 * Request bodies go on stdin (`--input -`), never on the command line.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { err, ok, type Result } from '../domain/result.ts';
import type { CodeHost, GitlabAccess, PortError } from '../ports/index.ts';
import { commentOnMergeRequest, instanceHost, mergeRequestBody, projectPath, toMergeRequestState, toOpenedMergeRequest, type DiffWait, type ProjectRequest } from './gitlab.ts';

export type GlabResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'exited'; readonly code: number; readonly stdout: string; readonly stderr: string };

const withoutKeys = (env: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)));

/** Runs glab with an argument list (no shell). Never rejects. */
export type GlabRun = (args: readonly string[], options?: { readonly stdin?: string; readonly timeoutMs?: number }) => Promise<GlabResult>;

const TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * `withheldEnv` keeps forge's own token variable away from glab: glab prefers GITLAB_TOKEN over its login, and in
 * glab mode the login is what the user chose.
 */
export const glabRunner =
  ({ executable = 'glab', withheldEnv = [] }: { readonly executable?: string; readonly withheldEnv?: readonly string[] } = {}): GlabRun =>
  (args, options = {}) =>
    new Promise((resolve) => {
      // From the home folder, not a repo: glab reads repo-local config from its working directory and fails
      // outright inside a git worktree. Forge always names the host, so no repo context is wanted.
      const child = execFile(
        executable,
        args,
        { cwd: homedir(), env: withoutKeys(process.env, withheldEnv), timeout: options.timeoutMs ?? TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve({ kind: 'missing' });
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          const timedOut = error?.killed ? `timed out after ${Math.round((options.timeoutMs ?? TIMEOUT_MS) / 1000)}s` : '';
          resolve({ kind: 'exited', code, stdout: String(stdout), stderr: timedOut || String(stderr) || (code !== 0 ? (error?.message ?? '') : '') });
        },
      );
      // A child that failed to start closes stdin under us; the callback above reports the real error.
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.stdin ?? '');
    });

const SIGNED_OUT = /glab auth login|not (?:been )?authenticated with glab|invalid_grant|unauthorized|http 401|not logged in|no token found/i;

/** glab's message on one line, without the "ERROR" banner it boxes some messages in, and wrapped lines rejoined. */
const message = (text: string, limit: number): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^error$/i.test(line))
    .join(' ')
    .slice(0, limit);

export type GlabFailure =
  | { readonly kind: 'missing' }
  | { readonly kind: 'signed_out'; readonly detail: string }
  | { readonly kind: 'failed'; readonly detail: string };

/** Why a glab call failed. Undefined when it succeeded. */
export const glabFailure = (result: GlabResult): GlabFailure | undefined => {
  if (result.kind === 'missing') return { kind: 'missing' };
  if (result.code === 0) return undefined;
  const detail = [message(result.stderr, 500), message(result.stdout, 500)].filter(Boolean).join(' ') || `glab exited with ${result.code}`;
  return SIGNED_OUT.test(result.stderr) ? { kind: 'signed_out', detail } : { kind: 'failed', detail };
};

const loginCommand = (host: string): string => `glab auth login --hostname ${host}`;

const portError = (host: string, request: string, failure: GlabFailure): PortError => {
  if (failure.kind === 'missing')
    return { port: 'gitlab', message: 'glab (the GitLab CLI) was not found on PATH where forge runs. Install it, or sign in to GitLab with a token.' };
  if (failure.kind === 'signed_out')
    return { port: 'gitlab', message: `glab is not signed in to ${host} (${failure.detail}). Run "${loginCommand(host)}" where forge runs.` };
  return { port: 'gitlab', message: `${request} -> ${failure.detail}` };
};

const parseJson = (text: string): Result<any, string> => {
  try {
    return ok(JSON.parse(text));
  } catch {
    return err(`unexpected answer from glab: ${text.slice(0, 200)}`);
  }
};

const apiArgs = (host: string, method: string, endpoint: string, withBody: boolean): readonly string[] => [
  'api',
  '--hostname',
  host,
  '--method',
  method,
  ...(withBody ? ['--header', 'Content-Type: application/json', '--input', '-'] : []),
  endpoint,
];

export const glabCodeHost = (opts: { readonly baseUrl: string; readonly project: string; readonly run: GlabRun; readonly diffWait?: DiffWait }): CodeHost => {
  const host = instanceHost(opts.baseUrl);
  const project = projectPath(opts.project);

  const request: ProjectRequest = async (method, path, body) => {
    const result = await opts.run(apiArgs(host, method, `${project}${path}`, body !== undefined), {
      stdin: body === undefined ? undefined : JSON.stringify(body),
    });
    const failure = glabFailure(result);
    if (failure) return err(portError(host, `${method} ${path}`, failure));
    const json = parseJson(result.kind === 'exited' ? result.stdout : '');
    return json.ok ? json : err({ port: 'gitlab', message: `${method} ${path}: ${json.error}` });
  };

  return {
    openMergeRequest: async (mr) => {
      const r = await request('POST', '/merge_requests', mergeRequestBody(mr));
      return r.ok ? ok(toOpenedMergeRequest(r.value)) : r;
    },

    getMergeRequest: async (iid) => {
      const r = await request('GET', `/merge_requests/${iid}`);
      return r.ok ? ok(toMergeRequestState(r.value)) : r;
    },

    commentOnMergeRequest: (iid, headSha, comments) => commentOnMergeRequest(request, iid, headSha, comments, opts.diffWait),
  };
};

/** Asks GitLab who glab is signed in as: proves the login and that the instance answers, in one call. */
export const glabAccess = async (opts: { readonly baseUrl: string; readonly run: GlabRun }): Promise<GitlabAccess> => {
  const host = instanceHost(opts.baseUrl);
  const result = await opts.run(['api', '--hostname', host, 'user'], { timeoutMs: PROBE_TIMEOUT_MS });
  const failure = glabFailure(result);
  if (failure?.kind === 'missing') return { kind: 'glab_missing', host };
  if (failure?.kind === 'signed_out') return { kind: 'glab_signed_out', host, detail: failure.detail };
  if (failure) return { kind: 'unreachable', host, detail: failure.detail };
  const user = parseJson(result.kind === 'exited' ? result.stdout : '');
  if (!user.ok || typeof user.value?.username !== 'string') return { kind: 'unreachable', host, detail: user.ok ? 'GitLab did not say who is signed in' : user.error };
  return { kind: 'ready', host, user: user.value.username };
};
