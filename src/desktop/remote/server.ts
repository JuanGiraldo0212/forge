/**
 * The forge server: a headless workspace backend driven over RPC. The desktop app starts it on an SSH
 * host, so agents, git, checks and files all run there; the app only shows the UI.
 *
 * Things that belong to the person, not the host, stay on their machine and are asked for over RPC:
 * picking a folder (the app shows a remote folder browser), recent workspaces, and the GitLab token
 * (kept in the local OS keychain).
 */
import { homedir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { workspaceBackend, type Backend } from '../main/backend.ts';
import type { WorkspaceSettings } from '../main/settings.ts';
import { METHODS, type Method } from '../shared/api.ts';
import { rpcPeer } from './rpc.ts';

/** Bumped when the app and server protocols stop being compatible. */
export const PROTOCOL = 1;

/** Env vars the app may set on the server (Claude credentials, the GitLab token's variable is set by name). */
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

const Hello = z.object({
  protocol: z.number(),
  env: z.record(z.string().regex(ENV_NAME), z.string().max(10_000)),
  canStoreToken: z.boolean(),
});

const Call = z.object({ method: z.enum(METHODS), args: z.array(z.unknown()) });

export type HelloResult = { readonly protocol: number; readonly home: string; readonly node: string };

export const serveForge = (input: Readable, output: Writable, opts: { readonly agentExecutable?: string } = {}) => {
  let backend: Backend | undefined;

  const peer = rpcPeer(input, output, {
    request: async (method, params) => {
      if (method === 'hello') {
        const hello = Hello.parse(params);
        if (hello.protocol !== PROTOCOL) throw new Error(`This host runs forge protocol ${PROTOCOL}, the app speaks ${hello.protocol}.`);
        for (const [name, value] of Object.entries(hello.env)) process.env[name] = value;
        backend ??= workspaceBackend({
          settings: remoteSettings(hello.canStoreToken),
          chooseFolder: async (title) => ((await peer.request('chooseFolder', { title })) as string | null) ?? undefined,
          // The app opens links itself; openExternal never reaches the host.
          openExternal: async () => {},
          events: {
            epicsChanged: () => peer.notify('epicsChanged'),
            busy: (busy) => peer.notify('busy', busy),
            opened: (info) => peer.notify('opened', info),
          },
          agentExecutable: opts.agentExecutable,
        });
        return { protocol: PROTOCOL, home: homedir(), node: process.version } satisfies HelloResult;
      }
      if (method === 'call') {
        if (!backend) throw new Error('Say hello first.');
        const call = Call.parse(params);
        return backend.dispatch(call.method as Method, call.args);
      }
      throw new Error(`Unknown method ${method}`);
    },
  });

  const remoteSettings = (canStoreToken: boolean): WorkspaceSettings => {
    const ask = (op: string, ...args: unknown[]) => peer.request('settings', { op, args });
    return {
      recent: async () => (await ask('recent')) as string[],
      addRecent: async (root) => void (await ask('addRecent', root)),
      token: async (env) => ((await ask('token', env)) as string | null) ?? undefined,
      setToken: async (env, token) => (await ask('setToken', env, token)) as Awaited<ReturnType<WorkspaceSettings['setToken']>>,
      canStoreToken: () => canStoreToken,
    };
  };

  return {
    /** Resolves when the app disconnects; agents still running are stopped. */
    done: peer.closed.then(() => backend?.close()),
  };
};
