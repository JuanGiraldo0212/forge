/**
 * Test fixtures: real git repos with bare remotes, real checks, a scripted agent, and fake GitLab projects.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsArtifactStore, fsEpicStore, fsRepoContext } from '../src/adapters/fs.ts';
import { gitVcs } from '../src/adapters/git.ts';
import { shellCheckRunner } from '../src/adapters/process.ts';
import { parseConfig } from '../src/application/config.ts';
import type { Deps, RepoDeps } from '../src/application/deps.ts';
import { err, ok, type Result } from '../src/domain/result.ts';
import type { AgentOutcome, AgentRequest, AgentRunner, CodeHost } from '../src/ports/index.ts';

/** Each agent call really spends this much. */
export const CALL_COST = 0.01;

export const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** A clone with an initial commit pushed to its own bare "origin". */
export const makeRepo = async (dir: string, name: string, files: Record<string, string> = { 'README.md': `# ${name}\n` }) => {
  const remote = join(dir, `${name}.git`);
  const repo = join(dir, name);
  sh(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(dir, 'clone', '-q', remote, repo);
  sh(repo, 'config', 'user.email', 'dev@example.com');
  sh(repo, 'config', 'user.name', 'Dev');
  sh(repo, 'checkout', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, '..'), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  sh(repo, 'push', '-q', 'origin', 'main');
  return { repo, remote };
};

export const fakeGitLab = (project: string): CodeHost & { readonly opened: { title: string; description: string; sourceBranch: string }[]; readonly merged: Set<number> } => {
  const opened: { title: string; description: string; sourceBranch: string }[] = [];
  const merged = new Set<number>();
  return {
    opened,
    merged,
    openMergeRequest: async (mr) => {
      opened.push(mr);
      return ok({ iid: opened.length, url: `https://gitlab.example/${project}/-/merge_requests/${opened.length}` });
    },
    getMergeRequest: async (iid): Promise<Result<any, any>> =>
      ok({ state: merged.has(iid) ? 'merged' : 'opened', pipeline: 'success', url: `https://gitlab.example/${project}/-/merge_requests/${iid}` }),
  };
};

export type Script = (
  req: AgentRequest,
) => Promise<{ text?: string; structured?: unknown; error?: string; questions?: AgentOutcome['questions'] } | undefined>;

/**
 * Behaves like the Agent SDK on cost: a resumed session reports its running total, not this call's spend.
 * `script` handles a request or returns undefined to fall through to the defaults.
 */
export const scriptedAgent = (calls: AgentRequest[], script: Script): AgentRunner => {
  const totals = new Map<string, number>();
  return {
    run: async (req) => {
      calls.push(req);
      const sessionId = req.resume ?? `s-${calls.length}`;
      const total = (totals.get(sessionId) ?? 0) + CALL_COST;
      totals.set(sessionId, total);
      const r = (await script(req)) ?? {};
      if (r.error) return err({ port: 'agent', message: r.error, sessionCostUsd: total });
      const outcome: AgentOutcome = { sessionId, text: r.text ?? '', structured: r.structured, sessionCostUsd: total, turns: 1, questions: r.questions };
      return ok(outcome);
    },
  };
};

export const REQUIREMENTS = `# Requirements
## Problem
Users need the thing.
## Functional requirements
- R1: The thing works.
  - Acceptance: tests pass
## Out of scope
Everything else.
## Open questions
None
`;

/** An epic spec planning the given changes ([id, repo, dependsOn]), each covering R1. */
export const epicSpec = (changes: readonly (readonly [string, string, string?])[] = [['C1', 'api']]) => `# Epic
## Summary
Ship the thing.
## Approach
Small and direct.
## Alternatives considered
None worth it.
## Changes
${changes.map(([id, repo, dep]) => `### ${id}: Change ${id}\n- Repo: ${repo}\n- Depends on: ${dep ?? 'none'}\n- Requirements: R1\n\nDoes ${id}.\n`).join('\n')}
## Verification
- tests pass
## Must not break
- README stays
## Risk
low — small change
`;

export const EPIC_SPEC = epicSpec();

export const stageOf = (req: AgentRequest): string => req.prompt.match(/^# Stage: ([a-z ]+)/)?.[1]?.trim() ?? '';

export type RepoSpec = { readonly name: string; readonly dir: string; readonly checks: { name: string; run: string }[] };

export const makeDeps = async (opts: {
  readonly workspace: string;
  readonly repos: readonly RepoSpec[];
  readonly worktrees: string;
  readonly agent: AgentRunner;
  readonly actor?: string;
}) => {
  const config = parseConfig({
    worktreeRoot: opts.worktrees,
    loop: { maxRounds: 6, maxIdenticalFailures: 3 },
    changes: { maxFilesPerChange: 4 },
    repos: Object.fromEntries(opts.repos.map((r) => [r.name, { path: r.dir, project: `group/${r.name}`, checks: r.checks }])),
  });
  assert.ok(config.ok, JSON.stringify(config));
  const hosts = Object.fromEntries(opts.repos.map((r) => [r.name, fakeGitLab(`group/${r.name}`)]));
  const repos: Record<string, RepoDeps> = Object.fromEntries(
    opts.repos.map((r) => [
      r.name,
      {
        name: r.name,
        root: r.dir,
        config: config.value.repos[r.name]!,
        vcs: gitVcs({ repoRoot: r.dir, worktreeRoot: join(opts.worktrees, r.name), remote: 'origin', baseBranch: 'main' }),
        host: hosts[r.name]!,
      },
    ]),
  );
  let tick = 0;
  const epicsRoot = join(opts.workspace, 'epics');
  const deps: Deps = {
    config: config.value,
    actor: opts.actor ?? 'owner@example.com',
    workspaceRoot: opts.workspace,
    epics: fsEpicStore(epicsRoot),
    artifacts: fsArtifactStore(epicsRoot),
    epicsRoot,
    context: fsRepoContext(opts.workspace),
    contextFor: (dir, o) => fsRepoContext(dir, o),
    repos,
    agent: opts.agent,
    checks: shellCheckRunner(),
    clock: () => new Date(Date.UTC(2026, 10, 4, 0, 0, 0, tick++)).toISOString(),
    log: { info: () => {}, warn: () => {} },
  };
  return { deps, hosts };
};

export const tempDir = () => mkdtemp(join(tmpdir(), 'forge-test-'));
