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
import type {
  AgentOutcome,
  AgentRequest,
  AgentRunner,
  CodeHost,
  MergeRequestComment,
  MergeRequestDiscussion,
  MergeRequestNote,
} from '../src/ports/index.ts';

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

export type PostedReview = { readonly iid: number; readonly headSha: string; readonly comments: readonly MergeRequestComment[] };

/** A pipeline on an MR's head: its id, the commit it ran on, and its failed jobs with their logs. */
export type FakePipeline = {
  readonly id: number;
  readonly sha?: string;
  readonly ref?: string;
  readonly status: string;
  readonly jobs: readonly { readonly id: number; readonly name: string; readonly log: string; readonly allowFailure?: boolean }[];
};

export const fakeGitLab = (
  project: string,
  /** The bare remote the MRs' branches are pushed to, so the MR head is the real pushed commit. */
  remote?: string,
): CodeHost & {
  readonly opened: { title: string; description: string; sourceBranch: string }[];
  readonly merged: Set<number>;
  readonly commented: PostedReview[];
  readonly closed: Set<number>;
  /** Threads by MR iid; tests add notes, forge's replies land here too. */
  readonly discussions: Map<number, MergeRequestDiscussion[]>;
  readonly replies: { iid: number; discussionId: string; body: string }[];
  readonly resolved: string[];
  /** Access level by user id (missing: not a member). */
  readonly members: Map<number, number>;
  /** The head pipeline by MR iid. Its sha defaults to the MR's head. */
  readonly pipelines: Map<number, FakePipeline>;
  /** Parents of merge commits (merged results pipelines run on them). */
  readonly mergeCommits: Map<string, readonly string[]>;
} => {
  const opened: { title: string; description: string; sourceBranch: string }[] = [];
  const merged = new Set<number>();
  const commented: PostedReview[] = [];
  const closed = new Set<number>();
  const discussions = new Map<number, MergeRequestDiscussion[]>();
  const replies: { iid: number; discussionId: string; body: string }[] = [];
  const resolved: string[] = [];
  const members = new Map<number, number>();
  const pipelines = new Map<number, FakePipeline>();
  const mergeCommits = new Map<string, readonly string[]>();
  let noteId = 1000;
  /** Like GitLab: the MR's head is whatever its source branch points at on the remote. */
  const headOf = (iid: number): string | undefined => {
    const branch = opened[iid - 1]?.sourceBranch;
    if (!remote || !branch) return undefined;
    try {
      return sh(remote, 'rev-parse', `refs/heads/${branch}`);
    } catch {
      return undefined;
    }
  };
  return {
    closed,
    discussions,
    replies,
    resolved,
    members,
    pipelines,
    mergeCommits,
    closeMergeRequest: async (iid) => {
      closed.add(iid);
      return ok(undefined);
    },
    opened,
    merged,
    commented,
    commentOnMergeRequest: async (iid, headSha, comments) => {
      commented.push({ iid, headSha, comments });
      const inline = comments.filter((c) => c.file && c.line).length;
      return { inline, general: comments.length - inline, failed: [] };
    },
    openMergeRequest: async (mr) => {
      opened.push(mr);
      return ok({ iid: opened.length, url: `https://gitlab.example/${project}/-/merge_requests/${opened.length}` });
    },
    getMergeRequest: async (iid): Promise<Result<any, any>> => {
      const p = pipelines.get(iid);
      const head = headOf(iid);
      return ok({
        state: merged.has(iid) ? 'merged' : closed.has(iid) ? 'closed' : 'opened',
        pipeline: p?.status ?? 'success',
        url: `https://gitlab.example/${project}/-/merge_requests/${iid}`,
        ...(head ? { headSha: head } : {}),
        ...(p ? { pipelineId: p.id, pipelineSha: p.sha ?? head ?? '' } : {}),
        ...(p?.ref ? { pipelineRef: p.ref } : {}),
      });
    },
    listDiscussions: async (iid) => ok(discussions.get(iid) ?? []),
    replyToDiscussion: async (iid, discussionId, body) => {
      replies.push({ iid, discussionId, body });
      const d = discussions.get(iid)?.find((x) => x.id === discussionId);
      if (d) (d.notes as MergeRequestNote[]).push({ id: noteId++, body, author: { id: 1, username: 'owner', bot: false }, system: false });
      return ok(undefined);
    },
    resolveDiscussion: async (_iid, discussionId) => {
      resolved.push(discussionId);
      return ok(undefined);
    },
    failedJobs: async (pipelineId) => {
      const p = [...pipelines.values()].find((x) => x.id === pipelineId);
      return ok((p?.jobs ?? []).map((j) => ({ id: j.id, name: j.name, allowFailure: Boolean(j.allowFailure) })));
    },
    commitParents: async (sha) => ok(mergeCommits.get(sha) ?? []),
    jobLog: async (jobId) => {
      const job = [...pipelines.values()].flatMap((p) => p.jobs).find((j) => j.id === jobId);
      return ok(job?.log ?? '');
    },
    accessLevel: async (userId) => ok(members.get(userId) ?? 0),
  };
};

/** A thread on an MR with one note, for the fake GitLab. */
export const thread = (
  id: string,
  noteId: number,
  author: { readonly id: number; readonly username: string; readonly bot?: boolean },
  body: string,
  where: { readonly file?: string; readonly line?: number } = {},
): MergeRequestDiscussion => ({
  id,
  resolved: false,
  notes: [{ id: noteId, body, author: { bot: false, ...author }, system: false, ...where }],
});

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
  readonly config?: Record<string, unknown>;
}) => {
  const config = parseConfig({
    ...opts.config,
    worktreeRoot: opts.worktrees,
    loop: { maxRounds: 6, maxIdenticalFailures: 3 },
    changes: { maxFilesPerChange: 4 },
    repos: Object.fromEntries(opts.repos.map((r) => [r.name, { path: r.dir, project: `group/${r.name}`, checks: r.checks }])),
  });
  assert.ok(config.ok, JSON.stringify(config));
  const hosts = Object.fromEntries(opts.repos.map((r) => [r.name, fakeGitLab(`group/${r.name}`, sh(r.dir, 'remote', 'get-url', 'origin'))]));
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
