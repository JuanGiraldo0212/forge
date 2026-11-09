/**
 * Guesses a repo's forge settings from a folder: name, GitLab project (from the git remote), base
 * branch, and setup/check commands (from the project's own files). Suggestions only; the user edits them.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { exec } from '../../adapters/process.ts';
import type { CheckEdit } from '../../application/configEdit.ts';

export type RepoGuess = {
  readonly root: string;
  readonly isGit: boolean;
  readonly name: string;
  /** Relative to the workspace, the form saved in the shared config. */
  readonly path: string;
  readonly project: string;
  readonly baseBranch: string;
  readonly remote: string;
  /** Host of the git remote's URL ('' when there is none); the dialog compares it with the GitLab URL. */
  readonly remoteHost: string;
  readonly setup: readonly string[];
  readonly checks: readonly CheckEdit[];
  readonly warnings: readonly string[];
};

/** "git@host:group/sub/proj.git", "ssh://git@host:2222/group/proj.git", "https://host/group/proj" → host + project path. */
export const parseRemote = (url: string): { readonly host: string; readonly project: string } | undefined => {
  const u = url.trim();
  const scp = u.match(/^[^@/\s]+@([^:/\s]+):(?!\/)(.+?)(?:\.git)?\/?$/);
  if (scp) return { host: scp[1]!, project: scp[2]! };
  const full = u.match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  return full ? { host: full[1]!, project: full[2]! } : undefined;
};

export const repoName = (folder: string): string =>
  basename(folder)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '') || 'repo';

type Detected = { readonly setup: readonly string[]; readonly checks: readonly CheckEdit[] };

const nodeCommands = async (root: string): Promise<Detected | undefined> => {
  const raw = await readFile(join(root, 'package.json'), 'utf8').catch(() => undefined);
  if (!raw) return undefined;
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(raw) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    // An unreadable package.json still means a Node project.
  }
  const pm = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(root, 'yarn.lock')) ? 'yarn' : existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')) ? 'bun' : 'npm';
  const install = { npm: existsSync(join(root, 'package-lock.json')) ? 'npm ci' : 'npm install', pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', bun: 'bun install' }[pm];
  const run = (script: string) => (pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`);
  const checks = [
    scripts.test ? { name: 'test', run: pm === 'npm' ? 'npm test' : `${pm} test` } : undefined,
    scripts.lint ? { name: 'lint', run: run('lint') } : undefined,
    scripts.typecheck ? { name: 'typecheck', run: run('typecheck') } : undefined,
  ].filter((c): c is CheckEdit => Boolean(c));
  return { setup: [install], checks };
};

const OTHER: readonly { readonly file: string; readonly setup: readonly string[]; readonly test: string }[] = [
  { file: 'go.mod', setup: [], test: 'go test ./...' },
  { file: 'Cargo.toml', setup: [], test: 'cargo test' },
  { file: 'pyproject.toml', setup: [], test: 'pytest' },
  { file: 'pom.xml', setup: [], test: 'mvn -q test' },
  { file: 'build.gradle', setup: [], test: './gradlew test' },
  { file: 'Gemfile', setup: ['bundle install'], test: 'bundle exec rake test' },
];

const detectCommands = async (root: string): Promise<Detected> => {
  const node = await nodeCommands(root);
  if (node) return node;
  const other = OTHER.find((o) => existsSync(join(root, o.file)));
  return other ? { setup: other.setup, checks: [{ name: 'test', run: other.test }] } : { setup: [], checks: [] };
};

export const inspectFolder = async (folder: string, workspaceRoot: string): Promise<RepoGuess> => {
  const top = await exec('git', ['rev-parse', '--show-toplevel'], folder);
  const root = top.code === 0 ? top.stdout.trim() : folder;
  const isGit = top.code === 0;
  const warnings: string[] = [];
  if (!isGit) warnings.push('This folder is not a git repository. Forge needs a clone with a remote.');

  const remoteName = isGit ? ((await exec('git', ['remote'], root)).stdout.split('\n').map((r) => r.trim()).filter(Boolean)[0] ?? 'origin') : 'origin';
  const url = isGit ? (await exec('git', ['remote', 'get-url', remoteName], root)).stdout.trim() : '';
  const parsed = url ? parseRemote(url) : undefined;
  if (isGit && !url) warnings.push(`No git remote found. Add one (git remote add origin …) so forge can push branches.`);

  const head = isGit ? (await exec('git', ['symbolic-ref', '--short', `refs/remotes/${remoteName}/HEAD`], root)).stdout.trim() : '';
  const baseBranch = head ? head.replace(`${remoteName}/`, '') : (await exec('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/main`], root)).code === 0 ? 'main' : 'master';

  const { setup, checks } = await detectCommands(root);
  if (checks.length === 0) warnings.push('No test command found. Add at least one check: forge only accepts changes whose checks pass.');

  const rel = relative(workspaceRoot, root) || '.';
  return {
    root,
    isGit,
    name: repoName(root),
    path: rel,
    project: parsed?.project ?? '',
    baseBranch,
    remote: remoteName,
    remoteHost: parsed?.host ?? '',
    setup,
    checks,
    warnings,
  };
};

/** Host of a clone's remote ('' when it isn't a clone or has no such remote). */
export const remoteHostOf = async (root: string, remote: string): Promise<string> => {
  const r = await exec('git', ['remote', 'get-url', remote], root);
  return r.code === 0 ? (parseRemote(r.stdout)?.host ?? '') : '';
};

export type DirEntry = { readonly name: string; readonly path: string; readonly git: boolean; readonly forge: boolean };

export type DirListing = {
  readonly path: string;
  /** null at the file system root. */
  readonly parent: string | null;
  readonly entries: readonly DirEntry[];
  readonly error?: string;
};

const MAX_ENTRIES = 500;

/** Sub-folders of `path` (default: home), hidden ones left out, marking git clones and forge workspaces. */
export const listDirectory = async (path: string | null): Promise<DirListing> => {
  const dir = resolve(path === null || path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  const parent = dirname(dir) === dir ? null : dirname(dir);
  try {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_ENTRIES)
      .map((name) => {
        const full = join(dir, name);
        return { name, path: full, git: existsSync(join(full, '.git')), forge: existsSync(join(full, '.forge', 'config.yaml')) };
      });
    return { path: dir, parent, entries };
  } catch (e) {
    return { path: dir, parent, entries: [], error: `Can't read ${dir}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
  }
};
