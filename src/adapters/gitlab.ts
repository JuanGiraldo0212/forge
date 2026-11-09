/**
 * GitLab REST adapter (v4). Needs a token with `api` scope in the env var named by config.gitlab.tokenEnv.
 * The request bodies and response decoding are shared with the glab adapter, so both send and read the same JSON.
 */
import { err, ok, type Result } from '../domain/result.ts';
import type { CodeHost, GitlabAccess, MergeRequestState, PortError } from '../ports/index.ts';

type Fetch = typeof fetch;
type NewMergeRequest = Parameters<CodeHost['openMergeRequest']>[0];

const fail = (message: string): Result<never, PortError> => err({ port: 'gitlab', message });

/** The instance's `host[:port]`, from gitlab.baseUrl; glab knows its logins by this name. */
export const instanceHost = (baseUrl: string): string => new URL(baseUrl).host;

/** The project's API path, relative to /api/v4. */
export const projectPath = (project: string): string => `projects/${encodeURIComponent(project)}`;

/** The POST /merge_requests body forge sends: squash, and delete the branch once merged. */
export const mergeRequestBody = (mr: NewMergeRequest) => ({
  source_branch: mr.sourceBranch,
  target_branch: mr.targetBranch,
  title: mr.title,
  description: mr.description,
  remove_source_branch: true,
  squash: true,
});

export const toOpenedMergeRequest = (json: any): { readonly iid: number; readonly url: string } => ({
  iid: Number(json.iid),
  url: String(json.web_url),
});

export const toMergeRequestState = (json: any): MergeRequestState => ({
  state: json.state,
  pipeline: json.head_pipeline?.status ?? undefined,
  url: json.web_url,
});

/** Token mode needs no network to know it can't work: the token is there or it isn't. */
export const tokenAccess = (opts: { readonly host: string; readonly tokenEnv: string; readonly token: string | undefined }): GitlabAccess =>
  opts.token ? { kind: 'ready', host: opts.host } : { kind: 'no_token', host: opts.host, tokenEnv: opts.tokenEnv };

export const gitlabCodeHost = (opts: {
  readonly baseUrl: string;
  readonly project: string;
  readonly token: string | undefined;
  readonly fetch?: Fetch;
}): CodeHost => {
  const doFetch = opts.fetch ?? fetch;
  const api = `${opts.baseUrl.replace(/\/$/, '')}/api/v4/${projectPath(opts.project)}`;

  const request = async (method: string, path: string, body?: unknown): Promise<Result<any, PortError>> => {
    if (!opts.token) return fail('GitLab token is not set (see gitlab.tokenEnv in .forge/config.yaml)');
    try {
      const res = await doFetch(`${api}${path}`, {
        method,
        headers: { 'PRIVATE-TOKEN': opts.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) return fail(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
      return ok(text ? JSON.parse(text) : undefined);
    } catch (e) {
      return fail(`${method} ${path}: ${(e as Error).message}`);
    }
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
  };
};
