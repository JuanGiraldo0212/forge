/**
 * Building approved changes: one agent per change, in a worktree of that change's repo, looped against
 * the repo's checks, then a revert test, then an independent review agent, then the human code-review gate.
 */
import { matchesGlob } from 'node:path';
import { z } from 'zod';
import { readyChanges, selectBatch, undeclaredChanges } from '../domain/changes.ts';
import { ARTIFACT_FILE, type ApprovedChange, type ChangeState, type Epic, type Finding } from '../domain/epic.ts';
import { approvalTarget, changesNeedingMergeRequest, type DomainError } from '../domain/lifecycle.ts';
import { escalationReason, failureSignature, needsRevertTest, reviewGateRequired, runCost } from '../domain/policy.ts';
import { err, ok, type Result } from '../domain/result.ts';
import type { MergeRequestState, Worktree } from '../ports/index.ts';
import { baseRef, changeBranch, emit, emitAsForge, forgeInternals, instructionsFor, loadEpic, repoFor, type Deps, type RepoDeps } from './deps.ts';
import {
  buildPrompt,
  checksFailedPrompt,
  extractJson,
  FINDINGS_SCHEMA,
  missingTestPrompt,
  reviewPrompt,
  revertTestFailedPrompt,
  systemPrompt,
} from './prompts.ts';
import { mergeRequestDescription } from './render.ts';

export type ChangeOutcome = {
  readonly changeId: string;
  readonly result: 'awaiting_review' | 'mr_open' | 'escalated' | 'failed';
  readonly detail: string;
};

export type BuildReport = {
  readonly outcomes: readonly ChangeOutcome[];
  /** Why nothing (more) could start, when the batch was empty. */
  readonly idle?: string;
};

type Approved = ChangeState & { readonly spec: ApprovedChange };

type Ctx = { readonly deps: Deps; readonly slug: string; readonly epicSpec: string };

type Verdict =
  | { readonly ok: true; readonly commit: string; readonly revertTest: 'passed' | 'skipped' }
  | { readonly ok: false; readonly signature: string; readonly prompt: string }
  | { readonly ok: false; readonly fatal: string };

const escalate = async (
  ctx: Ctx,
  changeId: string,
  reason: string,
  cost?: { readonly costUsd: number; readonly sessionCostUsd: number },
): Promise<ChangeOutcome> => {
  await emitAsForge(ctx.deps, ctx.slug, [{ type: 'ChangeEscalated', changeId, reason, ...cost }]);
  return { changeId, result: 'escalated', detail: reason };
};

const isTestFile = (globs: readonly string[]) => (file: string): boolean => globs.some((g) => matchesGlob(file, g));

/** Checks, commit, and (for feature/fix changes) the revert test. */
const verify = async (ctx: Ctx, repo: RepoDeps, wt: Worktree, change: Approved): Promise<Verdict> => {
  const { config, vcs } = repo;
  const { checks } = ctx.deps;
  const failed = (await checks.run(wt.path, config.checks)).filter((c) => !c.passed);
  const first = failed[0];
  if (first) return { ok: false, signature: failureSignature(first.name, first.output), prompt: checksFailedPrompt(failed) };

  const committed = await vcs.commitAll(wt, `${change.id}: ${change.title}\n\nForge-Epic: ${ctx.slug}\nForge-Change: ${change.id}`);
  if (!committed.ok) return { ok: false, fatal: committed.error.message };
  const head = await vcs.head(wt);
  if (!head.ok) return { ok: false, fatal: head.error.message };

  if (!needsRevertTest(change.spec.kind)) return { ok: true, commit: head.value, revertTest: 'skipped' };

  const changed = await vcs.changedFiles(wt, baseRef(config));
  if (!changed.ok) return { ok: false, fatal: changed.error.message };
  const isTest = isTestFile(config.revertTest.testGlobs);
  const tests = changed.value.filter((c) => isTest(c.path));
  const source = changed.value.filter((c) => !isTest(c.path));
  if (tests.length === 0)
    return { ok: false, signature: 'revert-test\nno test changes', prompt: missingTestPrompt(change.spec.kind, config.revertTest.testGlobs) };
  if (source.length === 0) return { ok: true, commit: head.value, revertTest: 'skipped' };

  const revertCheck = config.checks.filter((c) => c.name === config.revertTest.check);
  const restored = await vcs.restoreFromBase(wt, baseRef(config), source);
  const [result] = restored.ok ? await checks.run(wt.path, revertCheck) : [];
  const discarded = await vcs.discardChanges(wt);
  if (!restored.ok) return { ok: false, fatal: restored.error.message };
  if (!discarded.ok) return { ok: false, fatal: discarded.error.message };
  if (result?.passed)
    return { ok: false, signature: 'revert-test\nstill passes', prompt: revertTestFailedPrompt(config.revertTest.check) };
  return { ok: true, commit: head.value, revertTest: 'passed' };
};

const FindingsSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['blocking', 'advisory']),
      summary: z.string(),
      file: z.string().optional(),
      line: z.number().int().optional(),
      detail: z.string().optional(),
    }),
  ),
});

const parseFindings = (structured: unknown, text: string): Result<readonly Finding[], string> => {
  const parsed = FindingsSchema.safeParse(extractJson(structured, text));
  return parsed.success ? ok(parsed.data.findings) : err('reviewer did not return valid findings JSON');
};

const review = async (ctx: Ctx, repo: RepoDeps, wt: Worktree, change: Approved, revertTest: 'passed' | 'skipped'): Promise<ChangeOutcome> => {
  const { config, agent } = ctx.deps;
  const base = baseRef(repo.config);
  const [diff, changed] = await Promise.all([repo.vcs.diff(wt, base), repo.vcs.changedFiles(wt, base)]);
  if (!diff.ok) return escalate(ctx, change.id, diff.error.message);
  const undeclared = changed.ok ? undeclaredChanges(change.spec, changed.value.map((c) => c.path)) : [];

  ctx.deps.log.info(`[${change.id}] reviewing with ${config.models.reviewer}...`);
  const result = await agent.run({
    epic: ctx.slug,
    label: `review ${change.id}`,
    cwd: wt.path,
    mode: 'read',
    model: config.models.reviewer,
    systemPrompt: systemPrompt(await instructionsFor(ctx.deps, [{ name: repo.name, root: wt.path }], { claudeMd: false })),
    denyRead: forgeInternals(ctx.deps),
    prompt: reviewPrompt({ epicSpec: ctx.epicSpec, change, diff: diff.value, undeclared, revertTest }),
    maxTurns: config.loop.maxTurnsPerRound,
    outputSchema: FINDINGS_SCHEMA,
  });

  const parsed = result.ok ? parseFindings(result.value.structured, result.value.text) : err(result.error.message);
  // A review that did not happen must never look like a clean review.
  const findings: readonly Finding[] = [
    ...(parsed.ok ? parsed.value : [{ severity: 'blocking' as const, summary: `Automated review failed: ${parsed.error}` }]),
    ...(undeclared.length > 0
      ? [{ severity: 'advisory' as const, summary: `Changed files outside the change spec: ${undeclared.join(', ')}` }]
      : []),
  ];
  const gateRequired = reviewGateRequired(config.review.gate, change.spec.risk, findings);
  await emitAsForge(ctx.deps, ctx.slug, [
    {
      type: 'ChangeReviewed',
      changeId: change.id,
      findings,
      gateRequired,
      // Reviews always start a fresh session.
      costUsd: result.ok ? result.value.sessionCostUsd : result.error.sessionCostUsd,
    },
  ]);

  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  if (gateRequired)
    return { changeId: change.id, result: 'awaiting_review', detail: `${findings.length} findings (${blocking} blocking)` };

  const reloaded = await loadEpic(ctx.deps, ctx.slug);
  const current = reloaded.ok ? reloaded.value.changes.find((c) => c.id === change.id) : undefined;
  if (!reloaded.ok || !current) return escalate(ctx, change.id, 'change missing from the event log after review');
  return openMergeRequest(ctx.deps, reloaded.value, current);
};

const runChange = async (ctx: Ctx, change: Approved): Promise<ChangeOutcome> => {
  const { config, checks, agent, log } = ctx.deps;
  const repoDeps = repoFor(ctx.deps, change.spec.repo);
  if (!repoDeps.ok) return escalate(ctx, change.id, repoDeps.error.message);
  const repo = repoDeps.value;
  const branch = changeBranch(config, ctx.slug, change.id);
  const worktree = await repo.vcs.ensureWorktree(branch, baseRef(repo.config));
  if (!worktree.ok) return escalate(ctx, change.id, worktree.error.message);
  const wt = worktree.value;

  if (wt.created && repo.config.setup.length > 0) {
    const setup = await checks.run(wt.path, repo.config.setup.map((run, i) => ({ name: `setup-${i + 1}`, run })));
    const broken = setup.find((s) => !s.passed);
    if (broken) return escalate(ctx, change.id, `setup "${broken.name}" failed:\n${broken.output.slice(-2000)}`);
  }

  await emitAsForge(ctx.deps, ctx.slug, [{ type: 'ChangeStarted', changeId: change.id, branch }]);
  const revertTestRequired = needsRevertTest(change.spec.kind);
  // Instructions as of this change's branch, not the developer's clone. The SDK loads CLAUDE.md from the worktree itself.
  const system = systemPrompt(await instructionsFor(ctx.deps, [{ name: repo.name, root: wt.path }], { claudeMd: false }));
  let prompt = buildPrompt({
    epicSpec: ctx.epicSpec,
    change,
    repo: repo.name,
    checks: repo.config.checks.map((c) => c.run),
    testGlobs: repo.config.revertTest.testGlobs,
    revertTestRequired,
  });
  let sessionId = change.sessionId;
  // Running total of the resumed session; each round records only what it added.
  let sessionTotal = change.sessionId ? change.sessionCostUsd : undefined;
  const failures = [...change.failures];

  for (;;) {
    log.info(`[${change.id}] round ${failures.length + 1} on ${repo.name}:${branch}`);
    const round = await agent.run({
      epic: ctx.slug,
      label: change.id,
      cwd: wt.path,
      mode: 'build',
      model: config.models.author,
      systemPrompt: system,
      prompt,
      denyRead: forgeInternals(ctx.deps),
      maxTurns: config.loop.maxTurnsPerRound,
      resume: sessionId,
    });
    if (!round.ok) {
      const costUsd = runCost(round.error.sessionCostUsd, sessionId ? sessionTotal : undefined);
      const total = round.error.sessionCostUsd > 0 ? round.error.sessionCostUsd : sessionTotal;
      return escalate(ctx, change.id, `agent error: ${round.error.message}`, { costUsd, sessionCostUsd: total ?? 0 });
    }
    const costUsd = runCost(round.value.sessionCostUsd, sessionId ? sessionTotal : undefined);
    sessionId = round.value.sessionId;
    sessionTotal = round.value.sessionCostUsd;

    const verdict = await verify(ctx, repo, wt, change);
    if (verdict.ok) {
      await emitAsForge(ctx.deps, ctx.slug, [
        {
          type: 'ChangeImplemented',
          changeId: change.id,
          commit: verdict.commit,
          revertTest: verdict.revertTest,
          sessionId,
          costUsd,
          sessionCostUsd: sessionTotal,
        },
      ]);
      return review(ctx, repo, wt, change, verdict.revertTest);
    }
    if ('fatal' in verdict) return escalate(ctx, change.id, verdict.fatal, { costUsd, sessionCostUsd: sessionTotal });

    await emitAsForge(ctx.deps, ctx.slug, [
      { type: 'ChangeRoundFailed', changeId: change.id, signature: verdict.signature, sessionId, costUsd, sessionCostUsd: sessionTotal },
    ]);
    failures.push(verdict.signature);
    const stop = escalationReason(config.loop, failures);
    if (stop) return escalate(ctx, change.id, stop);
    prompt = verdict.prompt;
  }
};

/** Pushes the branch and opens the MR in the change's repo, or just pushes if the MR is still open (a rework). */
const openMergeRequest = async (deps: Deps, epic: Epic, change: ChangeState): Promise<ChangeOutcome> => {
  const fail = (detail: string): ChangeOutcome => ({ changeId: change.id, result: 'failed', detail });
  if (!change.spec) return fail('change has no approved spec');
  const repo = repoFor(deps, change.spec.repo);
  if (!repo.ok) return fail(repo.error.message);
  const branch = changeBranch(deps.config, epic.slug, change.id);
  const wt = await repo.value.vcs.ensureWorktree(branch, baseRef(repo.value.config));
  if (!wt.ok) return fail(wt.error.message);
  const pushed = await repo.value.vcs.push(wt.value);
  if (!pushed.ok) return fail(`push failed: ${pushed.error.message}`);

  const existing = change.mergeRequest ? await repo.value.host.getMergeRequest(change.mergeRequest.iid) : undefined;
  const reuse = change.mergeRequest && existing?.ok && existing.value.state === 'opened';
  const mr = reuse
    ? ok(change.mergeRequest!)
    : await repo.value.host.openMergeRequest({
        sourceBranch: branch,
        targetBranch: repo.value.config.baseBranch,
        title: `${change.id}: ${change.title}`,
        description: mergeRequestDescription(epic, change),
      });
  if (!mr.ok) return fail(`could not open MR: ${mr.error.message}`);
  await emitAsForge(deps, epic.slug, [{ type: 'MergeRequestOpened', changeId: change.id, iid: mr.value.iid, url: mr.value.url }]);
  return { changeId: change.id, result: 'mr_open', detail: mr.value.url };
};

const idleReason = (changes: readonly ChangeState[]): string => {
  const by = (s: ChangeState['status']) => changes.filter((c) => c.status === s).map((c) => c.id);
  const parts = [
    by('draft').length ? `change specs to review: ${by('draft').join(', ')}` : '',
    by('awaiting_review').length ? `code to review: ${by('awaiting_review').join(', ')}` : '',
    by('escalated').length ? `escalated (need your input): ${by('escalated').join(', ')}` : '',
    by('mr_open').length ? `MRs open (merge in GitLab, then sync): ${by('mr_open').join(', ')}` : '',
    by('ready').length ? `waiting on unmerged dependencies: ${by('ready').join(', ')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : 'nothing to build';
};

export const runBuild = async (deps: Deps, epic: Epic, force: boolean): Promise<Result<BuildReport, DomainError>> => {
  // A crashed run leaves changes "running". With --force they are handed back to the human, never silently restarted.
  const interrupted = epic.changes.filter((c) => c.status === 'running');
  if (interrupted.length > 0 && !force)
    return err({
      code: 'already_running',
      message: `Changes ${interrupted.map((c) => c.id).join(', ')} are running. If no forge process is running, use --force.`,
    });
  await emitAsForge(
    deps,
    epic.slug,
    interrupted.map((c) => ({ type: 'ChangeEscalated' as const, changeId: c.id, reason: 'interrupted: the previous run did not finish' })),
  );

  const retried = await Promise.all(changesNeedingMergeRequest(epic).map((c) => openMergeRequest(deps, epic, c)));

  const reloaded = await loadEpic(deps, epic.slug);
  if (!reloaded.ok) return reloaded;
  const batch = selectBatch(readyChanges(reloaded.value.changes), deps.config.build.maxParallel) as readonly Approved[];
  if (batch.length === 0) return ok({ outcomes: retried, idle: idleReason(reloaded.value.changes) });

  // Fetch only the repos this batch builds in.
  for (const name of new Set(batch.map((c) => c.spec.repo))) {
    const repo = repoFor(deps, name);
    if (!repo.ok) continue;
    const fetched = await repo.value.vcs.fetch();
    if (!fetched.ok) return err({ code: 'fetch_failed', message: `${name}: ${fetched.error.message}` });
  }

  const epicSpec = (await deps.artifacts.read(epic.slug, ARTIFACT_FILE.spec)) ?? '';
  const ctx: Ctx = { deps, slug: epic.slug, epicSpec };
  deps.log.info(`Starting ${batch.map((c) => `${c.id} (${c.spec.repo})`).join(', ')}`);
  const outcomes = await Promise.all(batch.map((c) => runChange(ctx, c)));
  return ok({ outcomes: [...retried, ...outcomes] });
};

/** The human code-review gate: approving pushes the branch and opens the MR. */
export const approveChangeCode = async (
  deps: Deps,
  slug: string,
  changeId: string,
  note: string | undefined,
): Promise<Result<ChangeOutcome, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const target = approvalTarget(loaded.value, changeId);
  if (!target.ok) return target;
  if (target.value.kind !== 'code') return err({ code: 'not_reviewable', message: `${changeId} has no code to review yet.` });
  await emit(deps, slug, [{ type: 'ChangeApproved', changeId, note }]);
  const reloaded = await loadEpic(deps, slug);
  if (!reloaded.ok) return reloaded;
  return ok(await openMergeRequest(deps, reloaded.value, reloaded.value.changes.find((c) => c.id === changeId)!));
};

export type SyncRow = { readonly changeId: string; readonly repo: string } & (MergeRequestState | { readonly error: string });

/** Pulls MR state from each repo's GitLab project. Merging itself stays a human action in GitLab. */
export const syncMergeRequests = async (deps: Deps, slug: string): Promise<Result<readonly SyncRow[], DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const open = loaded.value.changes.filter((c) => c.status === 'mr_open' && c.mergeRequest && c.spec);
  const rows = await Promise.all(
    open.map(async (c): Promise<SyncRow> => {
      const repoName = c.spec!.repo;
      const repo = repoFor(deps, repoName);
      if (!repo.ok) return { changeId: c.id, repo: repoName, error: repo.error.message };
      const state = await repo.value.host.getMergeRequest(c.mergeRequest!.iid);
      if (!state.ok) return { changeId: c.id, repo: repoName, error: state.error.message };
      if (state.value.state === 'merged') await emitAsForge(deps, slug, [{ type: 'ChangeMerged', changeId: c.id }]);
      if (state.value.state === 'closed')
        await emitAsForge(deps, slug, [{ type: 'ChangeEscalated', changeId: c.id, reason: 'MR closed without merging' }]);
      return { changeId: c.id, repo: repoName, ...state.value };
    }),
  );
  return ok(rows);
};

/** The change branch's diff against its repo's base, for review in a UI. */
export const changeDiff = async (deps: Deps, slug: string, changeId: string): Promise<Result<string, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const change = loaded.value.changes.find((c) => c.id === changeId);
  if (!change?.branch || !change.spec) return err({ code: 'no_branch', message: `Change ${changeId} has not started yet.` });
  const repo = repoFor(deps, change.spec.repo);
  if (!repo.ok) return repo;
  const wt = await repo.value.vcs.ensureWorktree(change.branch, baseRef(repo.value.config));
  if (!wt.ok) return err({ code: 'git', message: wt.error.message });
  const diff = await repo.value.vcs.diff(wt.value, baseRef(repo.value.config));
  return diff.ok ? ok(diff.value) : err({ code: 'git', message: diff.error.message });
};
