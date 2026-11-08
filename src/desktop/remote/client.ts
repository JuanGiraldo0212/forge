/**
 * Starts forge on an SSH host and talks to it. On first use (and after every app update) the server
 * bundle is copied to ~/.forge/server/<bundle id>/ on the host and its dependencies installed with npm,
 * like an editor's remote server. The host needs Node.js 24+, npm and git.
 */
import { z } from 'zod';
import { err, ok, type Result } from '../../domain/result.ts';
import type { WorkspaceSettings } from '../main/settings.ts';
import type { Method } from '../shared/api.ts';
import { rpcPeer } from './rpc.ts';
import { PROTOCOL, type HelloResult } from './server.ts';
import { inLoginShell, openSsh, shq, type SshError, type SshTarget } from './ssh.ts';

export type BundleFile = { readonly path: string; readonly content: Buffer };

export type ServerBundle = {
  /** Changes whenever any file or dependency changes; names the install folder on the host. */
  readonly id: string;
  /** Uploaded into the install folder (package.json included). */
  readonly files: readonly BundleFile[];
  /** Whether the folder needs `npm install` after uploading. */
  readonly install: boolean;
  /** Arguments to `node`, run from the install folder. */
  readonly args: readonly string[];
};

export const MIN_NODE_MAJOR = 24;

export type RemoteHooks = {
  readonly status: (text: string) => void;
  /** The server wants a folder on the host picked; null when the user cancels. */
  readonly chooseFolder: (title: string) => Promise<string | null>;
  /** Recent workspaces (for this host) and the GitLab token, kept on this machine. */
  readonly settings: WorkspaceSettings;
  /** Server events: epicsChanged, busy, opened. */
  readonly event: (name: string, payload: unknown) => void;
  /** The connection dropped (not called after close()). */
  readonly lost: (reason: string) => void;
  readonly log?: (line: string) => void;
};

export type RemoteServer = {
  readonly call: (method: Method, args: readonly unknown[]) => Promise<unknown>;
  readonly home: string;
  readonly close: () => void;
};

const MARK = '__FORGE_PROBE__';

export type Probe = { readonly home: string; readonly node: string; readonly npm: string; readonly git: string };

/** Reads HOME and tool versions from between markers, ignoring whatever the login shell prints around them. */
export const parseProbe = (stdout: string): Probe | undefined => {
  const m = stdout.match(new RegExp(`${MARK}(.*?)${MARK}`, 's'));
  if (!m) return undefined;
  const [home = '', node = '', npm = '', git = ''] = m[1]!.split('|').map((s) => s.trim());
  return home ? { home, node, npm, git } : undefined;
};

export const nodeMajor = (version: string): number | undefined => {
  const m = version.match(/^v?(\d+)\./);
  return m ? Number(m[1]) : undefined;
};

/** What's missing on the host for forge to run, as messages for the user. */
export const missingTools = (p: Probe, host: string): readonly string[] => {
  const major = nodeMajor(p.node);
  return [
    major === undefined
      ? `Node.js ${MIN_NODE_MAJOR}+ isn't installed on ${host} (forge runs there).`
      : major < MIN_NODE_MAJOR
        ? `${host} has Node.js ${p.node}; forge needs ${MIN_NODE_MAJOR} or newer.`
        : undefined,
    p.npm ? undefined : `npm isn't installed on ${host}.`,
    p.git ? undefined : `git isn't installed on ${host}.`,
  ].filter((m): m is string => Boolean(m));
};

const tail = (text: string, n = 1500) => (text.length > n ? `…${text.slice(-n)}` : text).trim();

const SettingsCall = z.object({ op: z.enum(['recent', 'addRecent', 'token', 'setToken']), args: z.array(z.unknown()) });

export const startRemote = async (
  target: SshTarget,
  opts: {
    readonly trustedFingerprint?: string;
    readonly bundle: ServerBundle;
    /** Environment for the server (Claude credentials); sent over the connection, never on a command line. */
    readonly env: Readonly<Record<string, string>>;
    readonly canStoreToken: boolean;
    readonly hooks: RemoteHooks;
  },
): Promise<Result<RemoteServer, SshError>> => {
  const { hooks, bundle } = opts;
  const label = `${target.username}@${target.host}`;
  const fail = (message: string) => err<SshError>({ kind: 'failed', message });

  hooks.status(`Connecting to ${label}…`);
  const opened = await openSsh(target, { trustedFingerprint: opts.trustedFingerprint });
  if (!opened.ok) return opened;
  const ssh = opened.value;
  const abort = (message: string) => (ssh.close(), fail(message));

  hooks.status(`Checking ${label}…`);
  const probe = parseProbe(
    (
      await ssh.run(
        inLoginShell(`printf '${MARK}%s|%s|%s|%s${MARK}' "$HOME" "$(node --version 2>/dev/null)" "$(npm --version 2>/dev/null)" "$(git --version 2>/dev/null)"`),
      )
    ).stdout,
  );
  if (!probe) return abort(`Couldn't run commands on ${label}.`);
  const missing = missingTools(probe, target.host);
  if (missing.length) return abort(missing.join(' '));

  const dir = `${probe.home}/.forge/server/${bundle.id}`;
  const installed = (await ssh.run(`test -f ${shq(`${dir}/.ready`)}`)).code === 0;
  if (!installed) {
    hooks.status(`Copying forge to ${label}…`);
    for (const file of bundle.files) {
      const path = `${dir}/${file.path}`;
      const r = await ssh.run(`mkdir -p ${shq(path.slice(0, path.lastIndexOf('/')))} && cat > ${shq(path)}`, file.content);
      if (r.code !== 0) return abort(`Couldn't copy forge to ${dir}: ${tail(r.stderr)}`);
    }
    if (bundle.install) {
      hooks.status(`Installing forge on ${label} (first time only, can take a minute)…`);
      const r = await ssh.run(inLoginShell(`cd ${shq(dir)} && npm install --omit=dev --no-audit --no-fund --loglevel=error`));
      if (r.code !== 0) return abort(`npm install failed on ${label}:\n${tail(r.stderr || r.stdout)}`);
    }
    await ssh.run(`touch ${shq(`${dir}/.ready`)}`);
  }

  hooks.status(`Starting forge on ${label}…`);
  let channel;
  try {
    channel = await ssh.spawn(inLoginShell(`cd ${shq(dir)} && exec node ${bundle.args.map(shq).join(' ')}`));
  } catch (e) {
    return abort(`Couldn't start forge on ${label}: ${(e as Error).message}`);
  }
  let stderr = '';
  channel.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-8000);
    for (const line of d.toString().split('\n')) if (line.trim()) hooks.log?.(line);
  });

  let closing = false;
  const peer = rpcPeer(channel, channel, {
    request: async (method, params) => {
      if (method === 'chooseFolder') return hooks.chooseFolder(z.object({ title: z.string() }).parse(params).title);
      if (method === 'settings') {
        const { op, args } = SettingsCall.parse(params);
        const s = hooks.settings;
        if (op === 'recent') return s.recent();
        if (op === 'addRecent') return s.addRecent(z.string().parse(args[0]));
        if (op === 'token') return (await s.token(z.string().parse(args[0]))) ?? null;
        return s.setToken(z.string().parse(args[0]), z.string().nullable().parse(args[1]));
      }
      throw new Error(`Unknown method ${method}`);
    },
    event: hooks.event,
    noise: hooks.log,
  });

  let hello: HelloResult;
  try {
    hello = (await peer.request('hello', { protocol: PROTOCOL, env: opts.env, canStoreToken: opts.canStoreToken }, 60_000)) as HelloResult;
  } catch (e) {
    return abort(`forge didn't start on ${label}: ${(e as Error).message}${stderr.trim() ? `\n${tail(stderr)}` : ''}`);
  }

  const close = () => {
    closing = true;
    channel.end();
    ssh.close();
  };
  void Promise.race([ssh.closed, peer.closed.then(() => `forge stopped on ${label}.${stderr.trim() ? ` ${tail(stderr, 500)}` : ''}`)]).then((reason) => {
    if (closing) return;
    close();
    hooks.lost(reason ?? `Lost the connection to ${label}.`);
  });

  return ok({
    home: hello.home,
    close,
    call: (method, args) => peer.request('call', { method, args }),
  });
};
