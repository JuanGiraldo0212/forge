/**
 * Building approved changes: one agent per change, in a worktree of that change's repo, looped against
 * the repo's checks, then a revert test, then an independent review agent whose findings go back to the author
 * for a bounded number of fix rounds, then the human code-review gate.
 *
 * A change whose MR is open is reworked the same way (from its owner's feedback, or from feedback the MR watcher
 * picked up) and pushed straight to the MR, where forge answers each thread it took on.
 */
import { matchesGlob } from 'node:path';
import { z } from 'zod';
import { readyChanges, selectBatch, transitiveDependencies, undeclaredChanges } from '../domain/changes.ts';
import {
  applyResponses,
  ARTIFACT_FILE,
  unresolved,
  type ApprovedChange,
  type ChangeState,
  type Epic,
  type FeedbackResponse,
  type Finding,
  type RepoSnapshot,
} from '../domain/epic.ts';
import { approvalTarget, canResumeWatch, changesNeedingMergeRequest, type DomainError } from '../domain/lifecycle.ts';
import { escalationReason, failureSignature, needsRevertTest, reviewGateRequired, runCost } from '../domain/policy.ts';
import { err, ok, type Result } from '../domain/result.ts';
import { autofixStop, autofixTargets, mergeRequestQuestions, mergeReview, newFindingQuestions, type Verdict as ReviewVerdict } from '../domain/review.ts';
import type { MergeRequestState, Worktree } from '../ports/index.ts';
import { baseRef, changeBranch, emit, emitAsForge, forgeInternals, instructionsFor, loadEpic, repoFor, type Deps, type RepoDeps } from './deps.ts';
import {
  buildPrompt,
  checksFailedPrompt,
  extractJson,
  FINDINGS_SCHEMA,
  mergeRequestFeedbackPrompt,
  missingTestPrompt,
  RESPONSES_SCHEMA,
  reviewFixPrompt,
  reviewPrompt,
  revertTestFailedPrompt,
  systemPrompt,
  type DependencyCode,
} from './prompts.ts';
import { cleanReviewComment, feedbackReply, findingComment, mergeRequestDescription } from './render.ts';

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

type RepoView = { readonly path: string; readonly ref: string; readonly commit?: string; readonly stale: boolean };

type Ctx = {
  readonly deps: Deps;
  readonly slug: string;
  readonly epicSpec: string;
  readonly changes: readonly ChangeState[];
  /** One refresh per repo per run: changes built in parallel may read the same repo. */
  readonly repoViews: Map<string, Promise<RepoView | undefined>>;
};

const refreshRepoView = async (deps: Deps, name: string): Promise<RepoView | undefined> => {
  const repo = repoFor(deps, name);
  if (!repo.ok) return undefined;
  const ref = baseRef(repo.value.config);
  const fetched = await repo.value.vcs.fetch();
  const snap = fetched.ok ? await repo.value.vcs.snapshot(ref) : undefined;
  if (snap?.ok) return { path: snap.value.path, ref, commit: snap.value.commit, stale: false };
  const last = await repo.value.vcs.existingSnapshot();
  deps.log.warn(`${name}: could not refresh ${ref}; ${last ? 'dependent builds read its last snapshot' : 'dependent builds go without its code'}.`);
  return last ? { path: last.path, ref, commit: last.commit, stale: true } : undefined;
};

const repoView = (ctx: Ctx, name: string): Promise<RepoView | undefined> => {
  const cached = ctx.repoViews.get(name) ?? refreshRepoView(ctx.deps, name);
  ctx.repoViews.set(name, cached);
  return cached;
};

/**
 * Read-only code of the other repositories holding this change's merged dependencies (direct or not), at
 * their base branch, so the agent builds against the real contract. Same-repo dependencies are already in
 * the worktree's base. A repo that can't be refreshed falls back to its last snapshot, or is left out.
 */
const dependencyCode = async (ctx: Ctx, change: Approved): Promise<readonly DependencyCode[]> => {
  const byRepo = new Map<string, string[]>();
  for (const d of transitiveDependencies(ctx.changes, change.id))
    if (d.repo !== change.spec.repo) byRepo.set(d.repo, [...(byRepo.get(d.repo) ?? []), d.id]);
  const code = await Promise.all(
    [...byRepo].map(async ([name, changes]): Promise<DependencyCode | undefined> => {
      const view = await repoView(ctx, name);
      return view && { repo: name, ...view, changes };
    }),
  );
  return code.filter((c): c is DependencyCode => c !== undefined);
};

const snapshotsOf = (code: readonly DependencyCode[]): readonly RepoSnapshot[] =>
  code.map((d) => ({ repo: d.repo, ref: d.ref, commit: d.commit, source: d.stale ? 'stale-snapshot' : 'snapshot' }));

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

const ReviewSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['blocking', 'advisory']),
      summary: z.string(),
      file: z.string().optional(),
      line: z.number().int().optional(),
      detail: z.string().optional(),
    }),
  ),
  previous: z
    .array(z.object({ id: z.string(), status: z.enum(['open', 'fixed', 'invalid']), note: z.string().optional() }))
    .optional(),
});

type ReviewAnswer = { readonly findings: readonly Finding[]; readonly verdicts: readonly ReviewVerdict[] };

const parseReview = (structured: unknown, text: string): Result<ReviewAnswer, string> => {
  const parsed = ReviewSchema.safeParse(extractJson(structured, text));
  return parsed.success
    ? ok({ findings: parsed.data.findings, verdicts: parsed.data.previous ?? [] })
    : err('reviewer did not return valid findings JSON');
};

const ResponsesSchema = z.object({
  responses: z.array(z.object({ id: z.string(), outcome: z.enum(['fixed', 'not_fixing', 'needs_input']), reply: z.string() })),
});

/** The author's answers, item by item. An answer that can't be read counts as no answer: the review still judges the code. */
const parseResponses = (structured: unknown, text: string): readonly FeedbackResponse[] => {
  const parsed = ResponsesSchema.safeParse(extractJson(structured, text));
  return parsed.success ? parsed.data.responses : [];
};

/** Findings forge adds itself (not the reviewer): they are recomputed on every review rather than judged. */
const REVIEW_FAILED = 'Automated review failed';
const UNDECLARED = 'Changed files outside the change spec';
const isForgeFinding = (f: Finding): boolean => f.summary.startsWith(REVIEW_FAILED) || f.summary.startsWith(UNDECLARED);

/**
 * Forge's own findings as of this review: one still true keeps its id and state (a dismissal sticks, it is not
 * posted again); one no longer true is fixed; a new one is returned to be numbered.
 */
const settleForgeFindings = (
  previous: readonly Finding[],
  now: readonly Finding[],
): { readonly findings: readonly Finding[]; readonly fresh: readonly Finding[] } => {
  const fresh: Finding[] = [];
  let findings = previous;
  for (const prefix of [REVIEW_FAILED, UNDECLARED]) {
    const current = now.find((f) => f.summary.startsWith(prefix));
    let matched = false;
    findings = findings.map((f): Finding => {
      if (!f.summary.startsWith(prefix) || f.status === 'fixed') return f;
      if (current && !matched) {
        matched = true;
        return { ...f, summary: current.summary };
      }
      return unresolved(f) ? { ...f, status: 'fixed', note: 'no longer the case' } : f;
    });
    if (current && !matched) fresh.push(current);
  }
  return { findings, fresh };
};

/** The change's MR is still open (a rework of code already approved). Not knowing counts as not open. */
const hasOpenMergeRequest = async (repo: RepoDeps, change: ChangeState): Promise<boolean> => {
  if (!change.mergeRequest) return false;
  const state = await repo.host.getMergeRequest(change.mergeRequest.iid);
  return state.ok && state.value.state === 'opened';
};

type Reviewed = {
  readonly findings: readonly Finding[];
  readonly costUsd: number;
  /** The reviewer gave no usable answer: its findings can't be fixed by the author. */
  readonly failed: boolean;
};

/**
 * One review of the committed change. The reviewer judges the earlier findings again and adds new ones; forge
 * merges the two, so a finding keeps its id from the review that raised it until it is fixed or dismissed.
 */
const reviewOnce = async (
  ctx: Ctx,
  repo: RepoDeps,
  wt: Worktree,
  change: Approved,
  revertTest: 'passed' | 'skipped',
  depCode: readonly DependencyCode[],
  previous: readonly Finding[],
): Promise<Result<Reviewed, string>> => {
  const { config, agent } = ctx.deps;
  const base = baseRef(repo.config);
  const [diff, changed] = await Promise.all([repo.vcs.diff(wt, base), repo.vcs.changedFiles(wt, base)]);
  if (!diff.ok) return err(diff.error.message);
  const undeclared = changed.ok ? undeclaredChanges(change.spec, changed.value.map((c) => c.path)) : [];

  ctx.deps.log.info(`[${change.id}] reviewing with ${config.models.reviewer}...`);
  const result = await agent.run({
    epic: ctx.slug,
    label: `review ${change.id}`,
    cwd: wt.path,
    additionalDirectories: depCode.map((d) => d.path),
    mode: 'read',
    model: config.models.reviewer,
    systemPrompt: systemPrompt(await instructionsFor(ctx.deps, [{ name: repo.name, root: wt.path }], { claudeMd: false })),
    denyRead: forgeInternals(ctx.deps),
    prompt: reviewPrompt({
      epicSpec: ctx.epicSpec,
      dependencyCode: depCode,
      change,
      diff: diff.value,
      undeclared,
      revertTest,
      previous: previous.filter((f) => !isForgeFinding(f)),
    }),
    maxTurns: config.loop.maxTurnsPerRound,
    outputSchema: FINDINGS_SCHEMA,
  });

  const parsed = result.ok ? parseReview(result.value.structured, result.value.text) : err(result.error.message);
  // A review that did not happen must never look like a clean review.
  const forge = settleForgeFindings(previous, [
    ...(parsed.ok ? [] : [{ severity: 'blocking' as const, summary: `${REVIEW_FAILED}: ${parsed.error}` }]),
    ...(undeclared.length > 0 ? [{ severity: 'advisory' as const, summary: `${UNDECLARED}: ${undeclared.join(', ')}` }] : []),
  ]);
  return ok({
    findings: mergeReview(forge.findings, parsed.ok ? parsed.value.verdicts : [], [...(parsed.ok ? parsed.value.findings : []), ...forge.fresh]),
    // Reviews always start a fresh session.
    costUsd: result.ok ? result.value.sessionCostUsd : result.error.sessionCostUsd,
    failed: !parsed.ok,
  });
};

/**
 * Records the final review of this attempt, then opens the human gate, or (when policy or an open MR skips it)
 * pushes. After a push to an open MR, questions the author left for the owner hand the change to them.
 */
const finishReview = async (
  ctx: Ctx,
  repo: RepoDeps,
  change: Approved,
  reviewed: Reviewed,
  autofixStopped: string | undefined,
  /** The findings when this run started: only questions raised since then are new for the owner. */
  before: readonly Finding[],
): Promise<ChangeOutcome> => {
  const { config } = ctx.deps;
  const { findings } = reviewed;
  // Once the MR is open the code was already approved: a rework goes straight to it, its review posted there.
  const mrOpen = await hasOpenMergeRequest(repo, change);
  const gateRequired = !mrOpen && reviewGateRequired(config.review.gate, change.spec.risk, findings);
  await emitAsForge(ctx.deps, ctx.slug, [
    {
      type: 'ChangeReviewed',
      changeId: change.id,
      findings,
      gateRequired,
      costUsd: reviewed.costUsd,
      ...(autofixStopped ? { autofixStopped } : {}),
    },
  ]);

  const open = findings.filter(unresolved);
  const blocking = open.filter((f) => f.severity === 'blocking').length;
  if (gateRequired)
    return { changeId: change.id, result: 'awaiting_review', detail: `${open.length} open findings (${blocking} blocking)` };

  const reloaded = await loadEpic(ctx.deps, ctx.slug);
  const current = reloaded.ok ? reloaded.value.changes.find((c) => c.id === change.id) : undefined;
  if (!reloaded.ok || !current) return escalate(ctx, change.id, 'change missing from the event log after review');
  const outcome = await openMergeRequest(ctx.deps, reloaded.value, current, mrOpen ? newFindingQuestions(findings, before) : []);
  // A rework that can't reach its open MR (someone pushed meanwhile, the remote refused) goes to the owner, never
  // sits approved where nothing follows the MR any more.
  if (outcome.result === 'failed' && mrOpen) return escalate(ctx, change.id, `the rework could not be pushed to the MR: ${outcome.detail}`);
  return outcome;
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

  // A rework of an open MR builds on what the MR has: commits someone else pushed (or GitLab's rebase) come first,
  // or forge's push would be refused.
  let othersCommits = false;
  if (change.mergeRequest && (await hasOpenMergeRequest(repo, change)) && (await repo.vcs.fetchBranch(branch))) {
    const remoteBranch = `${repo.config.remote}/${branch}`;
    if (!(await repo.vcs.contains(wt, remoteBranch))) {
      const reset = await repo.vcs.resetTo(wt, remoteBranch);
      if (!reset.ok) return escalate(ctx, change.id, `could not take the MR's latest commits: ${reset.error.message}`);
      othersCommits = true;
    }
  }

  const depCode = await dependencyCode(ctx, change);
  await emitAsForge(ctx.deps, ctx.slug, [
    { type: 'ChangeStarted', changeId: change.id, branch, ...(depCode.length ? { dependencySnapshots: snapshotsOf(depCode) } : {}) },
  ]);
  const revertTestRequired = needsRevertTest(change.spec.kind);
  // Instructions as of this change's branch, not the developer's clone. The SDK loads CLAUDE.md from the worktree itself.
  const system = systemPrompt(await instructionsFor(ctx.deps, [{ name: repo.name, root: wt.path }], { claudeMd: false }));
  const fullPrompt = (): string =>
    buildPrompt({
      epicSpec: ctx.epicSpec,
      dependencyCode: depCode,
      change,
      repo: repo.name,
      checks: repo.config.checks.map((c) => c.run),
      testGlobs: repo.config.revertTest.testGlobs,
      revertTestRequired,
    });
  // MR feedback not answered yet: picked up by the watcher (an automatic round), or held and now handed back by
  // the owner along with their own feedback (then the agent gets both).
  const mrFeedback = change.mergeRequestFeedback && !change.mergeRequestFeedback.responses ? change.mergeRequestFeedback.items : [];
  const othersNote = othersCommits
    ? '\nNote: someone else pushed commits to your MR since your last round; your worktree now has them. Build on them, do not undo them.\n'
    : '';
  let prompt = `${
    mrFeedback.length
      ? change.automation
        ? mergeRequestFeedbackPrompt(mrFeedback)
        : `${fullPrompt()}\n${mergeRequestFeedbackPrompt(mrFeedback)}`
      : fullPrompt()
  }${othersNote}`;
  /** What the next round's final message answers, item by item, if anything. */
  let answering: 'mr' | 'findings' | undefined = mrFeedback.length ? 'mr' : undefined;
  let sessionId = change.sessionId;
  // Running total of the resumed session; each round records only what it added.
  let sessionTotal = change.sessionId ? change.sessionCostUsd : undefined;
  const failures = [...change.failures];
  const autofix = config.review.autofix;
  let findings = change.findings;
  let fixRounds = 0;
  let lastTargets: readonly Finding[] | undefined;

  for (;;) {
    log.info(`[${change.id}] round ${failures.length + 1} on ${repo.name}:${branch}`);
    const round = await agent.run({
      epic: ctx.slug,
      label: change.id,
      cwd: wt.path,
      additionalDirectories: depCode.map((d) => d.path),
      mode: 'build',
      model: config.models.author,
      systemPrompt: system,
      prompt,
      denyRead: forgeInternals(ctx.deps),
      maxTurns: config.loop.maxTurnsPerRound,
      resume: sessionId,
      ...(answering ? { outputSchema: RESPONSES_SCHEMA } : {}),
    });
    if (!round.ok) {
      const costUsd = runCost(round.error.sessionCostUsd, sessionId ? sessionTotal : undefined);
      const total = round.error.sessionCostUsd > 0 ? round.error.sessionCostUsd : sessionTotal;
      return escalate(ctx, change.id, `agent error: ${round.error.message}`, { costUsd, sessionCostUsd: total ?? 0 });
    }
    const costUsd = runCost(round.value.sessionCostUsd, sessionId ? sessionTotal : undefined);
    sessionId = round.value.sessionId;
    sessionTotal = round.value.sessionCostUsd;

    if (answering) {
      const responses = parseResponses(round.value.structured, round.value.text);
      if (answering === 'mr') {
        await emitAsForge(ctx.deps, ctx.slug, [{ type: 'MergeRequestFeedbackAnswered', changeId: change.id, responses }]);
      } else {
        findings = applyResponses(findings, responses);
        await emitAsForge(ctx.deps, ctx.slug, [{ type: 'FindingsAnswered', changeId: change.id, responses }]);
      }
      answering = undefined;
    }

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
      const reviewed = await reviewOnce(ctx, repo, wt, change, verdict.revertTest, depCode, findings);
      if (!reviewed.ok) return escalate(ctx, change.id, reviewed.error);
      findings = reviewed.value.findings;

      // The author fixes what the reviewer found before anyone else looks, for a bounded number of rounds.
      const wanted = autofix.maxRounds > 0 ? autofixTargets(autofix, findings) : [];
      const targets = reviewed.value.failed ? [] : wanted;
      const stop = reviewed.value.failed
        ? wanted.length > 0 ? 'the review failed' : undefined
        : autofixStop(autofix, fixRounds, targets, lastTargets);
      if (targets.length > 0 && !stop) {
        fixRounds++;
        lastTargets = targets;
        await emitAsForge(ctx.deps, ctx.slug, [
          { type: 'ReviewFixRequested', changeId: change.id, round: fixRounds, findings, costUsd: reviewed.value.costUsd },
        ]);
        log.info(`[${change.id}] review found ${targets.length} to fix: fix round ${fixRounds}`);
        prompt = reviewFixPrompt(targets);
        answering = 'findings';
        continue;
      }
      return finishReview(ctx, repo, change, reviewed.value, stop, change.findings);
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

/**
 * Pushes the branch and opens the MR in the change's repo, or just pushes if the MR is still open (a rework), then
 * posts the review and answers the MR feedback the rework addressed. Questions the agent left for the owner (from
 * that feedback, or `findingQuestions` raised during the rework) then hand the change to them.
 */
const openMergeRequest = async (
  deps: Deps,
  epic: Epic,
  change: ChangeState,
  findingQuestions: readonly string[] = [],
): Promise<ChangeOutcome> => {
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
  // What was just pushed: the worktree's head, or else the last commit forge recorded (the same one).
  const head = await repo.value.vcs.head(wt.value);
  const pushedCommit = head.ok ? head.value : change.commit;
  if (!pushedCommit) deps.log.warn(`[${change.id}] nothing posted to MR !${mr.value.iid}: ${head.ok ? 'no commit' : head.error.message}`);
  else {
    await postReview(deps, epic.slug, repo.value, pushedCommit, change, mr.value.iid, Boolean(reuse));
    await answerFeedback(deps, epic.slug, repo.value, pushedCommit, change, mr.value.iid, Boolean(reuse));
  }
  const questions = [...findingQuestions, ...mergeRequestQuestions(change)];
  if (questions.length > 0) {
    const reason = `pushed to the MR, but its agent needs your decision:\n${questions.map((q) => `- ${q}`).join('\n')}`;
    await emitAsForge(deps, epic.slug, [{ type: 'ChangeEscalated', changeId: change.id, reason }]);
    return { changeId: change.id, result: 'escalated', detail: reason };
  }
  return { changeId: change.id, result: 'mr_open', detail: mr.value.url };
};

/**
 * Puts the latest review's findings on the MR as comments, once per review: a retried push or a reused MR
 * never posts the same review twice, a finding still open after a rework is not posted again, and a rework's
 * new review lands on the MR it updates. Commenting is best effort; it never fails the MR.
 */
const postReview = async (
  deps: Deps,
  slug: string,
  repo: RepoDeps,
  head: string,
  change: ChangeState,
  iid: number,
  rework: boolean,
): Promise<void> => {
  if (!deps.config.review.postToMergeRequest || change.reviewPosted) return;
  const posted = new Set(change.postedFindings ?? []);
  const open = change.findings.filter(unresolved);
  const fresh = open.filter((f) => !f.id || !posted.has(f.id));
  // A new MR's description already lists the findings; after a rework, say how the new commit came back.
  if (fresh.length === 0 && !rework) return;
  const comments = fresh.length
    ? fresh.map((f) => ({ body: findingComment(f, head), file: f.file, line: f.line }))
    : [{ body: cleanReviewComment(head, open.length) }];
  const result = await repo.host.commentOnMergeRequest(iid, head, comments);
  if (result.failed.length)
    deps.log.warn(`[${change.id}] ${result.failed.length} of ${comments.length} review comments not posted to MR !${iid}: ${result.failed[0]}`);
  if (result.inline + result.general > 0)
    await emitAsForge(deps, slug, [
      {
        type: 'ReviewCommentsPosted',
        changeId: change.id,
        iid,
        inline: result.inline,
        general: result.general,
        findingIds: fresh.flatMap((f) => (f.id ? [f.id] : [])),
      },
    ]);
};

/**
 * Answers, on the MR, each thread and failed pipeline the agent just worked on: fixed (in which commit), not
 * changed and why, or handed to the owner. Best effort; once tried, the feedback is done with.
 */
const answerFeedback = async (
  deps: Deps,
  slug: string,
  repo: RepoDeps,
  head: string,
  change: ChangeState,
  iid: number,
  sameMergeRequest: boolean,
): Promise<void> => {
  const feedback = change.mergeRequestFeedback;
  if (!feedback?.responses) return;
  // A new MR (the old one was closed or merged meanwhile) does not have the threads to answer.
  if (sameMergeRequest) {
    const { resolveThreads } = deps.config.mergeRequests.comments;
    for (const item of feedback.items) {
      const response = feedback.responses.find((r) => r.id === item.id);
      const body = feedbackReply(item, response, head);
      if (item.kind === 'comment') {
        const replied = await repo.host.replyToDiscussion(iid, item.discussionId, body);
        if (!replied.ok) deps.log.warn(`[${change.id}] could not reply on MR !${iid}: ${replied.error.message}`);
        else if (resolveThreads && response?.outcome === 'fixed') {
          const resolved = await repo.host.resolveDiscussion(iid, item.discussionId);
          if (!resolved.ok) deps.log.warn(`[${change.id}] could not resolve a thread on MR !${iid}: ${resolved.error.message}`);
        }
      } else {
        const posted = await repo.host.commentOnMergeRequest(iid, head, [{ body }]);
        if (posted.failed.length) deps.log.warn(`[${change.id}] could not comment on MR !${iid}: ${posted.failed[0]}`);
      }
    }
  }
  await emitAsForge(deps, slug, [{ type: 'MergeRequestFeedbackReplied', changeId: change.id, iid, commit: head }]);
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

/**
 * Builds every ready change (or, with `only`, just those: the MR watcher reworks the changes it picked feedback up
 * for, never starts others on its own).
 */
export const runBuild = async (
  deps: Deps,
  epic: Epic,
  force: boolean,
  only?: readonly string[],
): Promise<Result<BuildReport, DomainError>> => {
  const included = (c: ChangeState) => !only || only.includes(c.id);
  // A crashed run leaves changes "running". A forced run hands them back to the human, never silently restarts them.
  const interrupted = epic.changes.filter((c) => c.status === 'running');
  if (interrupted.length > 0 && !force)
    return err({
      code: 'already_running',
      message: `Changes ${interrupted.map((c) => c.id).join(', ')} are marked as running. If no agent is working on them, use "Recover interrupted".`,
    });
  await emitAsForge(
    deps,
    epic.slug,
    interrupted.map((c) => ({ type: 'ChangeEscalated' as const, changeId: c.id, reason: 'interrupted: the previous run did not finish' })),
  );

  const retried = await Promise.all(changesNeedingMergeRequest(epic).filter(included).map((c) => openMergeRequest(deps, epic, c)));

  const reloaded = await loadEpic(deps, epic.slug);
  if (!reloaded.ok) return reloaded;
  const batch = selectBatch(readyChanges(reloaded.value.changes).filter(included), deps.config.build.maxParallel) as readonly Approved[];
  if (batch.length === 0) return ok({ outcomes: retried, idle: idleReason(reloaded.value.changes) });

  // Fetch only the repos this batch builds in.
  for (const name of new Set(batch.map((c) => c.spec.repo))) {
    const repo = repoFor(deps, name);
    if (!repo.ok) continue;
    const fetched = await repo.value.vcs.fetch();
    if (!fetched.ok) return err({ code: 'fetch_failed', message: `${name}: ${fetched.error.message}` });
  }

  const epicSpec = (await deps.artifacts.read(epic.slug, ARTIFACT_FILE.spec)) ?? '';
  const ctx: Ctx = { deps, slug: epic.slug, epicSpec, changes: reloaded.value.changes, repoViews: new Map() };
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

/**
 * The owner hands an escalated change back to the MR watcher as it is (the held feedback was noise, a flaky
 * pipeline, a question they settled elsewhere): no rework, and the automatic rework count starts again.
 */
export const resumeWatching = async (deps: Deps, slug: string, changeId: string, note: string | undefined): Promise<Result<void, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const can = canResumeWatch(loaded.value, changeId);
  if (!can.ok) return can;
  const repo = repoFor(deps, can.value.spec?.repo ?? '');
  if (!repo.ok) return repo;
  if (!(await hasOpenMergeRequest(repo.value, can.value)))
    return err({ code: 'mr_not_open', message: `${changeId}'s MR is not open any more. Check it in GitLab, or ask for rework to open a new one.` });
  await emit(deps, slug, [{ type: 'MergeRequestWatchResumed', changeId, ...(note ? { note } : {}) }]);
  return ok(undefined);
};

export type SyncRow ={ readonly changeId: string; readonly repo: string } & (MergeRequestState | { readonly error: string });

/** Statuses of a change whose MR may be open: whatever forge or the owner is doing, the MR can be merged meanwhile. */
export const FOLLOWED: readonly ChangeState['status'][] = ['mr_open', 'escalated', 'ready', 'approved', 'awaiting_review'];

/**
 * Pulls MR state from each repo's GitLab project. Merging itself stays a human action in GitLab. A change with an
 * MR is followed whatever it is waiting for (its owner, a rework, a push retry): the MR can be merged meanwhile.
 */
export const syncMergeRequests = async (deps: Deps, slug: string): Promise<Result<readonly SyncRow[], DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const open = loaded.value.changes.filter((c) => FOLLOWED.includes(c.status) && c.mergeRequest && c.spec);
  const rows = await Promise.all(
    open.map(async (c): Promise<SyncRow> => {
      const repoName = c.spec!.repo;
      const repo = repoFor(deps, repoName);
      if (!repo.ok) return { changeId: c.id, repo: repoName, error: repo.error.message };
      const state = await repo.value.host.getMergeRequest(c.mergeRequest!.iid);
      if (!state.ok) return { changeId: c.id, repo: repoName, error: state.error.message };
      if (state.value.state === 'merged') await emitAsForge(deps, slug, [{ type: 'ChangeMerged', changeId: c.id }]);
      if (state.value.state === 'closed' && c.status === 'mr_open')
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
