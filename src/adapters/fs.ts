/**
 * File-system adapters. Workspace layout:
 *   .forge/config.yaml                    shared config (committed)
 *   .forge/local.yaml                     per-developer repo paths (not committed)
 *   .forge/rules/*.md                     learned rules, injected into every agent
 *   AGENTS.md                             team-wide instructions
 *   <epicsDir>/<slug>/events.jsonl        append-only event log (git merge=union)
 *   <epicsDir>/<slug>/idea.md, exploration.md, epic-spec.md, changes/C1.md ...
 */
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EpicEvent } from '../domain/epic.ts';
import type { ArtifactStore, EpicStore, RepoContext } from '../ports/index.ts';

export const forgeDir = (root: string): string => join(root, '.forge');

export const readOptional = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
};

export const fsEpicStore = (epicsRoot: string): EpicStore => ({
  list: async () => {
    try {
      const entries = await readdir(epicsRoot, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  },
  load: async (slug) => {
    const raw = await readOptional(join(epicsRoot, slug, 'events.jsonl'));
    const events = (raw ?? '')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as EpicEvent);
    // After a git union merge, two people's events can interleave out of order. Stable sort by time
    // restores it while keeping events written in one batch (same timestamp) in their original order.
    return [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  },
  append: async (slug, events) => {
    if (events.length === 0) return;
    const dir = join(epicsRoot, slug);
    await mkdir(dir, { recursive: true });
    // One write per batch: O_APPEND keeps concurrent writers from interleaving lines.
    await appendFile(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  },
});

export const fsArtifactStore = (epicsRoot: string): ArtifactStore => {
  const pathOf = (slug: string, name: string) => join(epicsRoot, slug, name);
  return {
    pathOf,
    read: (slug, name) => readOptional(pathOf(slug, name)),
    write: async (slug, name, content) => {
      await mkdir(dirname(pathOf(slug, name)), { recursive: true });
      await writeFile(pathOf(slug, name), content);
    },
    remove: (slug, name) => rm(pathOf(slug, name), { force: true }),
    list: async (slug, dir) => {
      try {
        return (await readdir(pathOf(slug, dir))).sort();
      } catch {
        return [];
      }
    },
  };
};

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', join('.claude', 'CLAUDE.md')];

/**
 * AGENTS.md, CLAUDE.md (root and .claude/) and every .forge/rules/*.md under `root` (the workspace,
 * a code repo, or a snapshot of one). `claudeMd: false` skips CLAUDE.md for agents whose own harness
 * already loads it from their working directory. Identical files (a symlink, a copy) appear once.
 */
export const fsRepoContext = (root: string, opts: { readonly claudeMd?: boolean } = {}): RepoContext => ({
  instructions: async () => {
    const names = opts.claudeMd === false ? ['AGENTS.md'] : INSTRUCTION_FILES;
    const docs = (await Promise.all(names.map(async (name) => ({ name, text: (await readOptional(join(root, name)))?.trim() ?? '' }))))
      .filter((d) => d.text)
      .filter((d, i, all) => all.findIndex((o) => o.text === d.text) === i);
    const agents = docs.map((d) => (docs.length > 1 ? `### ${d.name}\n\n${d.text}` : d.text)).join('\n\n');
    const rulesDir = join(forgeDir(root), 'rules');
    const ruleFiles = await readdir(rulesDir).catch(() => [] as string[]);
    const rules = await Promise.all(
      ruleFiles
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .sort()
        .map(async (f) => `### Rule: ${f.replace(/\.md$/, '')}\n\n${(await readOptional(join(rulesDir, f)))?.trim() ?? ''}`),
    );
    return [agents.trim(), ...rules].filter(Boolean).join('\n\n');
  },
});

export const readConfigFile = (root: string): Promise<string | undefined> => readOptional(join(forgeDir(root), 'config.yaml'));

export const readLocalConfigFile = (root: string): Promise<string | undefined> => readOptional(join(forgeDir(root), 'local.yaml'));

/** Writes the shared config, and local.yaml when there is something in it (or it already exists). */
export const writeConfigFiles = async (root: string, files: { readonly config: string; readonly local: string }): Promise<void> => {
  await mkdir(forgeDir(root), { recursive: true });
  await writeFile(join(forgeDir(root), 'config.yaml'), files.config);
  const localPath = join(forgeDir(root), 'local.yaml');
  if (files.local || (await readOptional(localPath)) !== undefined) await writeFile(localPath, files.local);
};

/** Writes a file only if it does not exist yet. Returns whether it wrote. */
export const writeIfMissing = async (path: string, content: string): Promise<boolean> => {
  if ((await readOptional(path)) !== undefined) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return true;
};

/** Appends a line to a file unless the line is already there. */
export const ensureLine = async (path: string, line: string): Promise<boolean> => {
  const current = (await readOptional(path)) ?? '';
  if (current.split('\n').includes(line)) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  return true;
};
