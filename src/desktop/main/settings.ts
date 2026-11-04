/**
 * Desktop settings: recent workspaces and the GitLab token. The token is stored only encrypted by the
 * OS keychain (Electron safeStorage); if the keychain is unavailable it is not stored at all.
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

const FileSchema = z.object({
  recent: z.array(z.string()).default([]),
  /** Encrypted tokens, base64, keyed by the env var name they stand in for. */
  tokens: z.record(z.string(), z.string()).default({}),
});

type SettingsFile = z.infer<typeof FileSchema>;

export type Settings = {
  readonly recent: () => Promise<readonly string[]>;
  readonly addRecent: (root: string) => Promise<void>;
  readonly token: (envName: string) => Promise<string | undefined>;
  readonly setToken: (envName: string, token: string | null) => Promise<Result<void, string>>;
  readonly canStoreToken: () => boolean;
};

const MAX_RECENT = 8;

export const fileSettings = (path: string, keychain: Keychain): Settings => {
  const load = async (): Promise<SettingsFile> => {
    try {
      const parsed = FileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      return parsed.success ? parsed.data : { recent: [], tokens: {} };
    } catch {
      return { recent: [], tokens: {} };
    }
  };
  const save = async (s: SettingsFile) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600 });
  };

  return {
    recent: async () => (await load()).recent,
    addRecent: async (root) => {
      const s = await load();
      await save({ ...s, recent: [root, ...s.recent.filter((r) => r !== root)].slice(0, MAX_RECENT) });
    },
    token: async (envName) => {
      const stored = (await load()).tokens[envName];
      if (!stored || !keychain.available()) return undefined;
      try {
        return keychain.decrypt(Buffer.from(stored, 'base64'));
      } catch {
        return undefined;
      }
    },
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
  };
};
