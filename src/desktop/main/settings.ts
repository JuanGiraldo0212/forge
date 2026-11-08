/**
 * Desktop settings: recent workspaces, the GitLab token, and saved SSH hosts. Secrets (the token, SSH
 * passwords) are stored only encrypted by the OS keychain (Electron safeStorage); if the keychain is
 * unavailable they are not stored at all.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { err, ok, type Result } from '../../domain/result.ts';

/** Injected so this module runs (and is tested) without Electron. */
export type Keychain = {
  readonly available: () => boolean;
  readonly encrypt: (plain: string) => Buffer;
  readonly decrypt: (cipher: Buffer) => string;
};

const HostSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  auth: z.enum(['password', 'key', 'agent']),
  keyPath: z.string().default(''),
  forwardClaude: z.boolean().default(true),
  /** SHA256 fingerprint of the host key the user trusted ("SHA256:…"). */
  fingerprint: z.string().optional(),
  /** Encrypted password, base64, when the user asked to remember it. */
  password: z.string().optional(),
  /** Workspaces opened on this host, most recent first. */
  recent: z.array(z.string()).default([]),
});

const FileSchema = z.object({
  recent: z.array(z.string()).default([]),
  /** Encrypted tokens, base64, keyed by the env var name they stand in for. */
  tokens: z.record(z.string(), z.string()).default({}),
  /** Saved SSH hosts, keyed by hostId(). */
  hosts: z.record(z.string(), HostSchema).default({}),
});

type SettingsFile = z.infer<typeof FileSchema>;

export type SshAuthKind = z.infer<typeof HostSchema>['auth'];

/** A saved host as the UI sees it: secrets reduced to whether one is stored. */
export type HostEntry = {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth: SshAuthKind;
  readonly keyPath: string;
  readonly forwardClaude: boolean;
  readonly fingerprint?: string;
  readonly savedPassword: boolean;
  readonly recent: readonly string[];
};

export type HostFields = Pick<HostEntry, 'host' | 'port' | 'username' | 'auth' | 'keyPath' | 'forwardClaude'>;

export const hostId = (h: { readonly host: string; readonly port: number; readonly username: string }): string =>
  `${h.username}@${h.host}${h.port === 22 ? '' : `:${h.port}`}`;

const EMPTY: SettingsFile = { recent: [], tokens: {}, hosts: {} };

export type Settings = {
  readonly recent: () => Promise<readonly string[]>;
  readonly addRecent: (root: string) => Promise<void>;
  readonly token: (envName: string) => Promise<string | undefined>;
  readonly setToken: (envName: string, token: string | null) => Promise<Result<void, string>>;
  readonly canStoreToken: () => boolean;

  readonly hosts: () => Promise<readonly HostEntry[]>;
  /** Saves (or updates) a host. `password`: a string stores it, null forgets it, undefined keeps what is stored. */
  readonly saveHost: (fields: HostFields, password?: string | null) => Promise<Result<HostEntry, string>>;
  readonly hostPassword: (id: string) => Promise<string | undefined>;
  readonly trustHost: (id: string, fingerprint: string) => Promise<void>;
  readonly forgetHost: (id: string) => Promise<void>;
  /** Recent workspaces on one host; `addHostRecent` records one. */
  readonly hostRecent: (id: string) => Promise<readonly string[]>;
  readonly addHostRecent: (id: string, root: string) => Promise<void>;
};

/** What a workspace backend needs from settings, whether it runs in the app or on an SSH host. */
export type WorkspaceSettings = Pick<Settings, 'recent' | 'addRecent' | 'token' | 'setToken' | 'canStoreToken'>;

const MAX_RECENT = 8;

const pushRecent = (list: readonly string[], root: string): string[] => [root, ...list.filter((r) => r !== root)].slice(0, MAX_RECENT);

export const fileSettings = (path: string, keychain: Keychain): Settings => {
  const load = async (): Promise<SettingsFile> => {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      return parsed.success ? parsed.data : EMPTY;
    } catch {
      return EMPTY;
    }
  };
  const save = async (s: SettingsFile) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  };
  const decrypt = (stored: string | undefined): string | undefined => {
    if (!stored || !keychain.available()) return undefined;
    try {
      return keychain.decrypt(Buffer.from(stored, 'base64'));
    } catch {
      return undefined;
    }
  };
  const updateHost = async (id: string, fn: (h: SettingsFile['hosts'][string]) => SettingsFile['hosts'][string]) => {
    const s = await load();
    const h = s.hosts[id];
    if (h) await save({ ...s, hosts: { ...s.hosts, [id]: fn(h) } });
  };
  const entry = (id: string, h: SettingsFile['hosts'][string]): HostEntry => ({
    id,
    host: h.host,
    port: h.port,
    username: h.username,
    auth: h.auth,
    keyPath: h.keyPath,
    forwardClaude: h.forwardClaude,
    fingerprint: h.fingerprint,
    savedPassword: Boolean(h.password),
    recent: h.recent,
  });

  return {
    recent: async () => (await load()).recent,
    addRecent: async (root) => {
      const s = await load();
      await save({ ...s, recent: pushRecent(s.recent, root) });
    },
    token: async (envName) => decrypt((await load()).tokens[envName]),
    setToken: async (envName, token) => {
      const s = await load();
      if (token === null) {
        const { [envName]: _, ...rest } = s.tokens;
        await save({ ...s, tokens: rest });
        return ok(undefined);
      }
      if (!keychain.available())
        return err(`The OS keychain is not available, so the token can't be stored safely. Set ${envName} in your environment instead.`);
      await save({ ...s, tokens: { ...s.tokens, [envName]: keychain.encrypt(token).toString('base64') } });
      return ok(undefined);
    },
    canStoreToken: () => keychain.available(),

    hosts: async () => Object.entries((await load()).hosts).map(([id, h]) => entry(id, h)),
    saveHost: async (fields, password) => {
      if (password && !keychain.available()) return err("The OS keychain is not available, so the password can't be stored safely.");
      const s = await load();
      const id = hostId(fields);
      const before = s.hosts[id];
      const stored = password === undefined ? before?.password : password === null ? undefined : keychain.encrypt(password).toString('base64');
      const next = { ...fields, fingerprint: before?.fingerprint, password: stored, recent: before?.recent ?? [] };
      await save({ ...s, hosts: { ...s.hosts, [id]: next } });
      return ok(entry(id, next));
    },
    hostPassword: async (id) => decrypt((await load()).hosts[id]?.password),
    trustHost: (id, fingerprint) => updateHost(id, (h) => ({ ...h, fingerprint })),
    forgetHost: async (id) => {
      const s = await load();
      const { [id]: _, ...rest } = s.hosts;
      await save({ ...s, hosts: rest });
    },
    hostRecent: async (id) => (await load()).hosts[id]?.recent ?? [],
    addHostRecent: (id, root) => updateHost(id, (h) => ({ ...h, recent: pushRecent(h.recent, root) })),
  };
};
