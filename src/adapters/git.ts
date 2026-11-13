/**
 * Git adapter: one worktree per task branch, outside the main checkout.
 * This process holds the git credentials; agents never push.
 */
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { err, ok, type Result } from '../domain/result.ts';
import type { ChangedFile, PortError, Vcs, Worktree } from '../ports/index.ts';
import { exec } from './process.ts';

const fail = (message: string): Result<never, PortError> => err({ port: 'git', message });

const git = async (cwd: string, args: readonly string[]): Promise<Result<string, PortError>> => {
  const r = await exec('git', args, cwd);
  return r.code === 0 ? ok(r.stdout) : fail(`git ${args.join(' ')}: ${r.stderr.trim() || `exit ${r.code}`}`);
};

/** "git@host:group/sub/proj.git", "ssh://git@host:2222/group/proj.git", "https://host/group/proj" → host + project path. */
export const parseRemote = (url: string): { readonly host: string; readonly project: string } | undefined => {
  const u = url.trim();
  const scp = u.match(/^[^@/\s]+@([^:/\s]+):(?!\/)(.+?)(?:\.git)?\/?$/);
  if (scp) return { host: scp[1]!, project: scp[2]! };
  const full = u.match(/^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  return full ? { host: full[1]!, project: full[2]! } : undefined;
};

const STATUS: Readonly<Record<string, ChangedFile['status']>> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };

export const parseNameStatus = (out: string): readonly ChangedFile[] =>
  out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code = '', a = '', b] = line.split('\t');
      const status = STATUS[code[0] ?? ''] ?? 'modified';
      return status === 'renamed' && b ? { path: b, status, from: a } : { path: a, status };
    });

export const gitVcs = (opts: { readonly repoRoot: string; readonly worktreeRoot: string; readonly remote: string; readonly baseBranch: string }): Vcs => {
  const { repoRoot, worktreeRoot, remote, baseBranch } = opts;

  const snapshotPath = join(worktreeRoot, '_planning');

  const existingSnapshot = async () => {
    if (!existsSync(join(snapshotPath, '.git'))) return undefined;
    const head = await git(snapshotPath, ['rev-parse', 'HEAD']);
    return head.ok ? { path: snapshotPath, commit: head.value.trim() } : undefined;
  };

  return {
    existingSnapshot,

    snapshot: async (base) => {
      if (!existsSync(join(snapshotPath, '.git'))) {
        // Drop a stale registration (e.g. the folder was deleted by hand) before re-adding.
        await exec('git', ['worktree', 'prune'], repoRoot);
        const added = await git(repoRoot, ['worktree', 'add', '--quiet', '--detach', snapshotPath, base]);
        if (!added.ok) return added;
      } else {
        const moved = await git(snapshotPath, ['checkout', '--quiet', '--detach', '--force', base]);
        if (!moved.ok) return moved;
        const cleaned = await git(snapshotPath, ['clean', '-fdq']);
        if (!cleaned.ok) return cleaned;
      }
      const snap = await existingSnapshot();
      return snap ? ok(snap) : fail(`could not read the planning snapshot at ${snapshotPath}`);
    },

    fetch: async () => {
      const r = await git(repoRoot, ['fetch', '--quiet', remote, baseBranch]);
      return r.ok ? ok(undefined) : r;
    },

    ensureWorktree: async (branch, base) => {
      const path = join(worktreeRoot, branch);
      if (existsSync(join(path, '.git'))) return ok({ path, branch, created: false });
      const hasBranch = (await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot)).code === 0;
      const r = await git(repoRoot, hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base]);
      return r.ok ? ok({ path, branch, created: true }) : r;
    },

    commitAll: async (wt, message) => {
      const added = await git(wt.path, ['add', '-A']);
      if (!added.ok) return added;
      const clean = (await exec('git', ['diff', '--cached', '--quiet'], wt.path)).code === 0;
      if (clean) return ok(undefined);
      const committed = await git(wt.path, ['commit', '--quiet', '-m', message]);
      if (!committed.ok) return committed;
      const head = await git(wt.path, ['rev-parse', 'HEAD']);
      return head.ok ? ok(head.value.trim()) : head;
    },

    head: async (wt) => {
      const r = await git(wt.path, ['rev-parse', 'HEAD']);
      return r.ok ? ok(r.value.trim()) : r;
    },

    changedFiles: async (wt, base) => {
      const r = await git(wt.path, ['diff', '--name-status', '-M', `${base}...HEAD`]);
      return r.ok ? ok(parseNameStatus(r.value)) : r;
    },

    diff: (wt, base) => git(wt.path, ['diff', '-M', `${base}...HEAD`]),

    restoreFromBase: async (wt, base, files) => {
      const mergeBase = await git(wt.path, ['merge-base', base, 'HEAD']);
      if (!mergeBase.ok) return mergeBase;
      const at = mergeBase.value.trim();
      for (const f of files) {
        if (f.status === 'added' || f.status === 'renamed') await rm(join(wt.path, f.path), { force: true });
        const original = f.status === 'renamed' ? f.from : f.status === 'added' ? undefined : f.path;
        if (original) {
          const r = await git(wt.path, ['checkout', at, '--', original]);
          if (!r.ok) return r;
        }
      }
      return ok(undefined);
    },

    discardChanges: async (wt: Worktree) => {
      const reset = await git(wt.path, ['reset', '--quiet', '--hard', 'HEAD']);
      if (!reset.ok) return reset;
      const clean = await git(wt.path, ['clean', '-fdq']);
      return clean.ok ? ok(undefined) : clean;
    },

    push: async (wt, pushOpts = {}) => {
      const r = await git(wt.path, ['push', '--quiet', ...(pushOpts.force ? ['--force'] : []), '-u', remote, wt.branch]);
      return r.ok ? ok(undefined) : r;
    },

    fetchBranch: async (branch) => {
      const r = await exec('git', ['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], repoRoot);
      return r.code === 0;
    },

    resetTo: async (wt, ref) => {
      const reset = await git(wt.path, ['reset', '--quiet', '--hard', ref]);
      if (!reset.ok) return reset;
      const clean = await git(wt.path, ['clean', '-fdq']);
      return clean.ok ? ok(undefined) : clean;
    },

    writeFiles: async (wt, files) => {
      try {
        for (const f of files) {
          const path = join(wt.path, f.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, f.content);
        }
        return ok(undefined);
      } catch (e) {
        return fail(`writing files in ${wt.path}: ${(e as Error).message}`);
      }
    },
  };
};
