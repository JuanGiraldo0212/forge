/**
 * The forge server as uploaded to SSH hosts: the built JavaScript next to the app's main process
 * (out/main/server.js and the chunks it shares with the app) plus a package.json pinning the runtime
 * dependencies to the versions this app ships with. npm on the host installs the right native
 * Claude Code binary for its platform.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { err, ok, type Result } from '../../domain/result.ts';
import type { BundleFile, ServerBundle } from '../remote/client.ts';

/** Every package the server imports at runtime. A test keeps this in sync with the server's imports. */
export const SERVER_DEPENDENCIES = ['@anthropic-ai/claude-agent-sdk', 'yaml', 'zod'] as const;

const ENTRY = 'server.js';

/** The installed version of a package, found by walking up from `from` through node_modules folders. */
export const installedVersion = async (name: string, from: string): Promise<string | undefined> => {
  for (let dir = from; ; dir = dirname(dir)) {
    const pkg = join(dir, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(pkg)) return (JSON.parse(await readFile(pkg, 'utf8')) as { version?: string }).version;
    if (dirname(dir) === dir) return undefined;
  }
};

const jsFiles = async (root: string, dir = root): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? jsFiles(root, join(dir, e.name)) : Promise.resolve(/\.(m|c)?js$/.test(e.name) ? [join(dir, e.name)] : []))),
  );
  return nested.flat();
};

/** Builds the bundle from the main-process build folder (where index.js and server.js sit). */
export const loadServerBundle = async (buildDir: string): Promise<Result<ServerBundle, string>> => {
  if (!existsSync(join(buildDir, ENTRY))) return err(`The forge server isn't built (${join(buildDir, ENTRY)} is missing). Run "npm run build".`);
  const dependencies: Record<string, string> = {};
  for (const name of SERVER_DEPENDENCIES) {
    const version = await installedVersion(name, buildDir);
    if (!version) return err(`Can't find the installed version of ${name}.`);
    dependencies[name] = version;
  }
  const code: BundleFile[] = await Promise.all(
    (await jsFiles(buildDir))
      // The app's own entry (it imports Electron) is not needed on the host.
      .filter((f) => relative(buildDir, f) !== 'index.js')
      .sort()
      .map(async (f) => ({ path: relative(buildDir, f).split(sep).join('/'), content: await readFile(f) })),
  );
  const pkg = { name: 'forge-server', private: true, type: 'module', dependencies };
  const files = [...code, { path: 'package.json', content: Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`) }];
  const hash = createHash('sha256');
  for (const f of files) hash.update(f.path).update('\0').update(f.content).update('\0');
  return ok({ id: hash.digest('hex').slice(0, 16), files, install: true, args: [ENTRY] });
};
