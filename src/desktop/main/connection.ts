/**
 * Where the app's workspace backend runs: in this process (local) or on an SSH host (remote). Every
 * ForgeApi call goes to the active backend; connecting and disconnecting switch it. Electron-free,
 * so it is tested with a fake transport.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Result } from '../../domain/result.ts';
import type { RemoteHooks, RemoteServer, ServerBundle } from '../remote/client.ts';
import type { SshAuth, SshError, SshTarget } from '../remote/ssh.ts';
import type { ConnectionChange, ConnectionInfo, ConnectionMethod, ConnectRequest, ConnectResult, FolderRequest, Method, Outcome, WorkspaceInfo } from '../shared/api.ts';
import type { Backend } from './backend.ts';
import { hostId, type Settings } from './settings.ts';

/** Claude credentials an agent on the host can use, when the user chooses to pass them along. */
export const CLAUDE_ENV = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

export type ConnectionDeps = {
  readonly settings: Settings;
  readonly local: Backend;
  readonly bundle: () => Promise<Result<ServerBundle, string>>;
  readonly start: (
    target: SshTarget,
    opts: { trustedFingerprint?: string; bundle: ServerBundle; env: Readonly<Record<string, string>>; canStoreToken: boolean; hooks: RemoteHooks },
  ) => Promise<Result<RemoteServer, SshError>>;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly env: NodeJS.ProcessEnv;
  /** To the renderer. */
  readonly send: (event: 'epicsChanged' | 'busy' | 'connectionStatus' | 'connectionChanged' | 'pickFolder', payload?: unknown) => void;
  /** The workspace shown changed (for the window title). */
  readonly shown: (workspace: WorkspaceInfo | null, connection: ConnectionInfo) => void;
  readonly log?: (line: string) => void;
};

const name = z.string().trim().min(1).max(255).regex(/^[^\s]+$/, 'no spaces');

const ConnectSchema = z.object({
  host: name,
  port: z.number().int().min(1).max(65535),
  username: name,
  auth: z.enum(['password', 'key', 'agent']),
  password: z.string().max(1000),
  rememberPassword: z.boolean(),
  keyPath: z.string().max(4096),
  passphrase: z.string().max(1000),
  forwardClaude: z.boolean(),
  trustFingerprint: z.string().max(200).nullable(),
});

const ARGS = {
  connection: z.tuple([]),
  savedHosts: z.tuple([]),
  connectRemote: z.tuple([ConnectSchema]),
  disconnectRemote: z.tuple([]),
  forgetHost: z.tuple([z.string().max(600)]),
  folderPicked: z.tuple([z.number().int(), z.string().max(4096).nullable()]),
} satisfies Record<ConnectionMethod, z.ZodTuple>;

type Remote = {
  readonly server: RemoteServer;
  readonly info: Extract<ConnectionInfo, { kind: 'remote' }>;
  busy: readonly string[];
};

const LOCAL: ConnectionInfo = { kind: 'local' };

export const connectionManager = (deps: ConnectionDeps) => {
  let remote: Remote | undefined;
  let connecting = false;
  let nextPick = 1;
  const picks = new Map<number, (path: string | null) => void>();

  const busy = (): readonly string[] => (remote ? remote.busy : deps.local.busy());
  const connection = (): ConnectionInfo => remote?.info ?? LOCAL;

  const dropPicks = () => {
    for (const resolve of picks.values()) resolve(null);
    picks.clear();
  };

  const changed = async (error?: string) => {
    const change: ConnectionChange = { connection: connection(), error };
    deps.send('connectionChanged', change);
    deps.shown((await active().dispatch('workspace', [])) as WorkspaceInfo | null, change.connection);
  };

  const remoteBackend = (r: Remote): Backend => ({
    // Links open on this machine, never on the host.
    dispatch: (method, args) => (method === 'openExternal' ? deps.local.dispatch(method, args) : r.server.call(method, args)),
    busy: () => r.busy,
    close: () => r.server.close(),
  });

  const active = (): Backend => (remote ? remoteBackend(remote) : deps.local);

  const authFor = async (req: ConnectRequest, id: string): Promise<SshAuth | string> => {
    if (req.auth === 'password') {
      const password = req.password || (await deps.settings.hostPassword(id));
      return password ? { kind: 'password', password } : 'Enter the password.';
    }
    if (req.auth === 'key') {
      const path = req.keyPath.trim() || join(homedir(), '.ssh', 'id_ed25519');
      const full = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
      try {
        return { kind: 'key', privateKey: await deps.readFile(full), passphrase: req.passphrase || undefined };
      } catch {
        return `Can't read the private key at ${full}.`;
      }
    }
    const socket = deps.env.SSH_AUTH_SOCK;
    return socket ? { kind: 'agent', socket } : 'No SSH agent is running (SSH_AUTH_SOCK is not set). Use a password or a key file.';
  };

  const connectRemote = async (req: ConnectRequest): Promise<ConnectResult> => {
    if (connecting) return { ok: false, error: 'Already connecting.' };
    if (busy().length) return { ok: false, error: `Agents are running on ${busy().join(', ')}. Stop them before switching.` };
    const id = hostId(req);
    const saved = (await deps.settings.hosts()).find((h) => h.id === id);
    const auth = await authFor(req, id);
    if (typeof auth === 'string') return { ok: false, error: auth };
    const bundle = await deps.bundle();
    if (!bundle.ok) return { ok: false, error: bundle.error };
    const trusted = req.trustFingerprint ?? saved?.fingerprint;
    const label = id;

    connecting = true;
    const wasRemote = remote !== undefined;
    let started: Result<RemoteServer, SshError>;
    let pending: Remote | undefined;
    try {
      if (remote) {
        remote.server.close();
        remote = undefined;
        dropPicks();
      }
      const env = Object.fromEntries(
        req.forwardClaude ? CLAUDE_ENV.flatMap((k) => (deps.env[k] ? [[k, deps.env[k]!] as const] : [])) : [],
      );
      started = await deps.start(
        { host: req.host, port: req.port, username: req.username, auth },
        {
          trustedFingerprint: trusted,
          bundle: bundle.value,
          env,
          canStoreToken: deps.settings.canStoreToken(),
          hooks: {
            status: (text) => deps.send('connectionStatus', text),
            chooseFolder: (title) =>
              new Promise((resolve) => {
                const request: FolderRequest = { id: nextPick++, title };
                picks.set(request.id, resolve);
                deps.send('pickFolder', request);
              }),
            settings: {
              recent: () => deps.settings.hostRecent(id),
              addRecent: (root) => deps.settings.addHostRecent(id, root),
              token: deps.settings.token,
              setToken: deps.settings.setToken,
              canStoreToken: deps.settings.canStoreToken,
            },
            event: (event, payload) => {
              const current = remote ?? pending;
              if (!current) return;
              if (event === 'busy') {
                current.busy = Array.isArray(payload) ? payload.filter((s): s is string => typeof s === 'string') : [];
                deps.send('busy', current.busy);
              } else if (event === 'epicsChanged') deps.send('epicsChanged');
              else if (event === 'opened') deps.shown(payload as WorkspaceInfo, current.info);
            },
            lost: (reason) => {
              if (!remote || remote !== pending) return;
              remote = undefined;
              dropPicks();
              void changed(reason);
            },
            log: (line) => deps.log?.(`[${label}] ${line}`),
          },
        },
      );
    } finally {
      connecting = false;
    }

    if (!started.ok) {
      if (wasRemote) void changed();
      const e = started.error;
      if (e.kind === 'host-key') {
        const changedKey = Boolean(saved?.fingerprint) && saved?.fingerprint !== e.fingerprint;
        return {
          ok: false,
          hostKey: { fingerprint: e.fingerprint, changed: changedKey },
          error: changedKey
            ? `The host key of ${req.host} has changed. This can mean someone is intercepting the connection. Only continue if you know the server was reinstalled or its key rotated.`
            : `First connection to ${req.host}. Check that the host key fingerprint matches the server's before trusting it.`,
        };
      }
      return { ok: false, error: e.message };
    }

    pending = { server: started.value, info: { kind: 'remote', id, label, home: started.value.home }, busy: [] };
    remote = pending;
    const typed = req.auth === 'password' && req.password ? req.password : undefined;
    await deps.settings.saveHost(
      { host: req.host, port: req.port, username: req.username, auth: req.auth, keyPath: req.keyPath, forwardClaude: req.forwardClaude },
      req.auth !== 'password' || !req.rememberPassword ? null : typed,
    );
    if (trusted) await deps.settings.trustHost(id, trusted);
    await changed();
    return { ok: true, connection: remote.info };
  };

  const disconnectRemote = async (): Promise<Outcome> => {
    if (!remote) return { ok: true, text: 'Not connected.', tone: 'info' };
    if (remote.busy.length) return { ok: false, text: `Agents are running on ${remote.busy.join(', ')}. Stop them before disconnecting.`, tone: 'error' };
    const label = remote.info.label;
    remote.server.close();
    remote = undefined;
    dropPicks();
    await changed();
    return { ok: true, text: `Disconnected from ${label}.`, tone: 'success' };
  };

  const impl: { readonly [M in ConnectionMethod]: (...args: z.infer<(typeof ARGS)[M]>) => Promise<unknown> } = {
    connection: async () => connection(),
    savedHosts: () => deps.settings.hosts(),
    connectRemote: (req) => connectRemote(req),
    disconnectRemote,
    forgetHost: (id) => deps.settings.forgetHost(id),
    folderPicked: async (id, path) => {
      picks.get(id)?.(path);
      picks.delete(id);
    },
  };

  return {
    busy,
    connection,
    isRemote: () => remote !== undefined,
    /** Connection methods are answered here; everything else goes to the active backend. */
    dispatch: async (method: Method | ConnectionMethod, args: readonly unknown[]): Promise<unknown> => {
      if (method in ARGS) {
        const m = method as ConnectionMethod;
        const parsed = ARGS[m].safeParse(args);
        if (!parsed.success) throw new Error(`Invalid arguments for ${m}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        return (impl[m] as (...a: unknown[]) => Promise<unknown>)(...(parsed.data as unknown[]));
      }
      return active().dispatch(method as Method, args);
    },
    close: () => {
      remote?.server.close();
      remote = undefined;
      deps.local.close();
    },
  };
};
