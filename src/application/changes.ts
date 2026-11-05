/**
 * The change specs stage: draft the set, redraft single changes, approve them one by one, drop them,
 * then approve the whole set to start development. Building approved changes is in build.ts.
 */
import { z } from 'zod';
import {
  ChangeHeaderSchema,
  parseChangeSpec,
  renderChangeSpec,
  validateChange,
  validateDraftSet,
  type ChangeDraft,
} from '../domain/changes.ts';
import { ARTIFACT_FILE, changeFile, type ApprovedChange, type ChangeState, type Epic } from '../domain/epic.ts';
import { approvalTarget, canApproveChangeSet, canDropChange, canRevisePlan, revisionTarget, type DomainError } from '../domain/lifecycle.ts';
import { plannedChanges } from '../domain/spec.ts';
import { err, ok, type Result } from '../domain/result.ts';
import { approveChangeCode, runBuild, type BuildReport, type ChangeOutcome } from './build.ts';
import { emit, emitAsForge, loadEpic, type Deps } from './deps.ts';
import { changesPrompt, changesSchema, extractJson, reviseChangePrompt } from './prompts.ts';
import { planningRequest, preparePlanning, snapshotRecord } from './planning.ts';
import { docInputs } from './stages.ts';

const DraftsSchema = z.object({
  changes: z.array(
    ChangeHeaderSchema.extend({
      goal: z.string().min(1),
      behavior: z.string().min(1),
      verification: z.array(z.string().min(1)).min(1),
      mustNotBreak: z.array(z.string().min(1)).min(1),
    }),
  ),
});

const parseDrafts = (structured: unknown, text: string): Result<readonly ChangeDraft[], readonly string[]> => {
  const parsed = DraftsSchema.safeParse(extractJson(structured, text));
  return parsed.success
    ? ok(parsed.data.changes)
    : err(parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`));
};

const isDraft = (c: ChangeState): boolean => c.status === 'draft' || c.status === 'revising';

const limits = (deps: Deps) => ({ maxFilesPerChange: deps.config.changes.maxFilesPerChange, repos: Object.keys(deps.repos) });

const readChange = (deps: Deps, slug: string, id: string) => deps.artifacts.read(slug, changeFile(id));

/** Every live change's dependency edges: approved snapshots, plus whatever the draft files say. */
const liveGraph = async (deps: Deps, epic: Epic) =>
  Promise.all(
    epic.changes
      .filter((c) => c.status !== 'dropped')
      .map(async (c) => {
        if (c.spec) return { id: c.id, dependsOn: c.spec.dependsOn };
        const parsed = parseChangeSpec((await readChange(deps, epic.slug, c.id)) ?? '', c.id);
        return { id: c.id, dependsOn: parsed.ok ? parsed.value.dependsOn : [] };
      }),
  );

/** Why a change spec cannot be approved yet; empty when it can. */
export const changeIssues = async (deps: Deps, epic: Epic, changeId: string): Promise<readonly string[]> => {
  const md = await readChange(deps, epic.slug, changeId);
  if (md === undefined) return [`${changeFile(changeId)} is missing`];
  const parsed = parseChangeSpec(md, changeId);
  if (!parsed.ok) return parsed.error;
  const checked = validateChange(parsed.value, await liveGraph(deps, epic), limits(deps));
  return checked.ok ? [] : checked.error;
};

const failStage = async (deps: Deps, slug: string, reason: string, costUsd: number): Promise<Result<never, DomainError>> => {
  await emitAsForge(deps, slug, [{ type: 'StageFailed', stage: 'changes', reason, costUsd }]);
  return err({ code: 'agent_failed', message: reason });
};

/** Drafts the whole set of not-yet-approved change specs (first time, or after plan-level feedback). */
const draftAll = async (deps: Deps, epic: Epic): Promise<Result<readonly string[], DomainError>> => {
  const view = await preparePlanning(deps);
  await emitAsForge(deps, epic.slug, [{ type: 'StageStarted', stage: 'changes', snapshots: snapshotRecord(view) }]);
  deps.log.info(`Drafting change specs for "${epic.slug}"...`);
  const approved: readonly ApprovedChange[] = epic.changes.flatMap((c) => (c.spec && c.status !== 'dropped' ? [c.spec] : []));
  const reserved = epic.changes.filter((c) => !isDraft(c)).map((c) => c.id);
  const currentDrafts = epic.changes.filter(isDraft);
  const drafts = (await Promise.all(currentDrafts.map((c) => readChange(deps, epic.slug, c.id)))).filter((d): d is string => !!d);

  const inputs = await docInputs(deps, epic, view);
  const result = await deps.agent.run({
    ...(await planningRequest(
      deps,
      view,
      epic.slug,
      'changes',
      changesPrompt({ ...inputs, approved, drafts, reserved, maxFilesPerChange: deps.config.changes.maxFilesPerChange }),
    )),
    outputSchema: changesSchema(Object.keys(deps.repos)),
  });
  if (!result.ok) return failStage(deps, epic.slug, `change specs agent failed: ${result.error.message}`, result.error.sessionCostUsd);

  const parsed = parseDrafts(result.value.structured, result.value.text);
  const valid = parsed.ok ? validateDraftSet(parsed.value, reserved) : parsed;
  if (!valid.ok)
    return failStage(deps, epic.slug, `change specs agent returned an invalid set: ${valid.error.join('; ')}`, result.value.sessionCostUsd);

  const ids = valid.value.map((d) => d.id);
  const removed = currentDrafts.map((c) => c.id).filter((id) => !ids.includes(id));
  for (const d of valid.value) await deps.artifacts.write(epic.slug, changeFile(d.id), renderChangeSpec(d));
  for (const id of removed) await deps.artifacts.remove(epic.slug, changeFile(id));
  await emitAsForge(deps, epic.slug, [
    {
      type: 'ChangesDrafted',
      drafts: valid.value.map((d) => ({ id: d.id, title: d.title })),
      removed,
      full: true,
      costUsd: result.value.sessionCostUsd,
    },
  ]);
  return ok(ids);
};

/** Redrafts one change spec with the human's feedback. */
const redraft = async (deps: Deps, epic: Epic, change: ChangeState): Promise<Result<string, DomainError>> => {
  deps.log.info(`Revising change spec ${change.id}...`);
  const view = await preparePlanning(deps);
  const others = await Promise.all(
    epic.changes
      .filter((c) => c.id !== change.id && c.status !== 'dropped')
      .map(async (c) => c.spec?.markdown ?? (await readChange(deps, epic.slug, c.id)) ?? ''),
  );
  const inputs = await docInputs(deps, epic, view);
  const result = await deps.agent.run({
    ...(await planningRequest(
      deps,
      view,
      epic.slug,
      change.id,
      reviseChangePrompt({
        ...inputs,
        current: (await readChange(deps, epic.slug, change.id)) ?? '',
        feedback: change.specFeedback,
        others,
        maxFilesPerChange: deps.config.changes.maxFilesPerChange,
      }),
    )),
    outputSchema: changesSchema(Object.keys(deps.repos)),
  });
  if (!result.ok) return failStage(deps, epic.slug, `revising ${change.id} failed: ${result.error.message}`, result.error.sessionCostUsd);

  const parsed = parseDrafts(result.value.structured, result.value.text);
  const revised = parsed.ok ? parsed.value.find((d) => d.id === change.id) : undefined;
  if (!revised)
    return failStage(deps, epic.slug, `revising ${change.id}: the agent did not return that change`, result.value.sessionCostUsd);

  await deps.artifacts.write(epic.slug, changeFile(change.id), renderChangeSpec(revised));
  await emitAsForge(deps, epic.slug, [
    {
      type: 'ChangesDrafted',
      drafts: [{ id: revised.id, title: revised.title }],
      removed: [],
      full: false,
      snapshots: snapshotRecord(view),
      costUsd: result.value.sessionCostUsd,
    },
  ]);
  return ok(change.id);
};

export type ChangesReport = {
  readonly drafted: readonly string[];
  readonly revised: readonly string[];
  readonly errors: readonly string[];
};

/** One run in the change specs stage: draft the set, or redraft what got feedback. Nothing builds here. */
export const runChanges = async (deps: Deps, epic: Epic): Promise<Result<ChangesReport, DomainError>> => {
  const errors: string[] = [];
  let drafted: readonly string[] = [];
  if (epic.changes.length === 0 || epic.pendingFeedback.length > 0) {
    const r = await draftAll(deps, epic);
    if (r.ok) drafted = r.value;
    else errors.push(r.error.message);
  }

  const afterDraft = await loadEpic(deps, epic.slug);
  if (!afterDraft.ok) return afterDraft;
  const revised: string[] = [];
  for (const change of afterDraft.value.changes.filter((c) => c.status === 'revising')) {
    const r = await redraft(deps, afterDraft.value, change);
    if (r.ok) revised.push(r.value);
    else errors.push(r.error.message);
  }

  return ok({ drafted, revised, errors });
};

/** One run in the development stage: build what is ready, and retry MRs that failed to open. */
export const runDevelopment = (deps: Deps, epic: Epic, force: boolean): Promise<Result<BuildReport, DomainError>> =>
  runBuild(deps, epic, force);

export type ChangeSetApproval = {
  /** Changes the epic spec planned that have no change spec (e.g. merged away by plan-level feedback). */
  readonly unplanned: readonly string[];
  readonly missing: readonly string[];
};

/**
 * The change specs gate: every live change spec is approved, so the epic moves on to development.
 * Differences from the epic spec's plan are reported, not blocking: plan-level feedback may split or merge changes.
 */
export const approveChangeSet = async (deps: Deps, slug: string, note: string | undefined): Promise<Result<ChangeSetApproval, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const can = canApproveChangeSet(loaded.value);
  if (!can.ok) return can;
  const planned = plannedChanges((await deps.artifacts.read(slug, ARTIFACT_FILE.spec)) ?? '').map((p) => p.id);
  const ids = loaded.value.changes.map((c) => c.id);
  await emit(deps, slug, [{ type: 'ChangeSetApproved', note }]);
  return ok({ missing: planned.filter((id) => !ids.includes(id)), unplanned: ids.filter((id) => !planned.includes(id)) });
};

export type ApprovalOutcome =
  | { readonly kind: 'spec'; readonly changeId: string }
  | { readonly kind: 'code'; readonly outcome: ChangeOutcome };

const approveSpec = async (deps: Deps, epic: Epic, changeId: string, note: string | undefined): Promise<Result<ApprovalOutcome, DomainError>> => {
  const md = (await readChange(deps, epic.slug, changeId)) ?? '';
  const parsed = parseChangeSpec(md, changeId);
  const checked = parsed.ok ? validateChange(parsed.value, await liveGraph(deps, epic), limits(deps)) : parsed;
  if (!checked.ok)
    return err({
      code: 'gate_blocked',
      message: `Cannot approve ${changeId}:\n${checked.error.map((i) => `  - ${i}`).join('\n')}\nEdit ${deps.artifacts.pathOf(epic.slug, changeFile(changeId))} or revise it.`,
    });
  await emit(deps, epic.slug, [{ type: 'ChangeSpecApproved', changeId, spec: checked.value, note }]);
  return ok({ kind: 'spec', changeId });
};

/** Approves a draft's spec, or a reviewed change's code (which opens its MR). */
export const approveChange = async (
  deps: Deps,
  slug: string,
  changeId: string,
  note: string | undefined,
): Promise<Result<ApprovalOutcome, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const target = approvalTarget(loaded.value, changeId);
  if (!target.ok) return target;
  if (target.value.kind === 'spec') return approveSpec(deps, loaded.value, changeId, note);
  const code = await approveChangeCode(deps, slug, changeId, note);
  return code.ok ? ok({ kind: 'code', outcome: code.value }) : code;
};

/** Approves every draft that passes its checks; reports the rest. */
export const approveAllDrafts = async (
  deps: Deps,
  slug: string,
  note: string | undefined,
): Promise<Result<{ readonly approved: readonly string[]; readonly blocked: readonly string[] }, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const drafts = loaded.value.changes.filter((c) => c.status === 'draft');
  if (drafts.length === 0) return err({ code: 'no_drafts', message: 'No draft change specs to approve.' });
  const approved: string[] = [];
  const blocked: string[] = [];
  for (const c of drafts) {
    // Reload each time so a change can depend on one approved a moment ago.
    const current = await loadEpic(deps, slug);
    if (!current.ok) return current;
    const r = await approveSpec(deps, current.value, c.id, note);
    if (r.ok) approved.push(c.id);
    else blocked.push(r.error.message);
  }
  return ok({ approved, blocked });
};

/** Feedback on a draft redrafts its spec; feedback on code reworks the implementation. */
export const reviseChange = async (
  deps: Deps,
  slug: string,
  changeId: string,
  note: string,
): Promise<Result<'spec' | 'code', DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const target = revisionTarget(loaded.value, changeId);
  if (!target.ok) return target;
  await emit(deps, slug, [
    target.value.kind === 'spec'
      ? { type: 'ChangeSpecRevisionRequested', changeId, note }
      : { type: 'ChangeReworkRequested', changeId, note },
  ]);
  return ok(target.value.kind);
};

/** Feedback on the set as a whole ("split C2", "add a migration change"): redrafts every unapproved change. */
export const revisePlan = async (deps: Deps, slug: string, note: string): Promise<Result<void, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const can = canRevisePlan(loaded.value);
  if (!can.ok) return can;
  await emit(deps, slug, [{ type: 'RevisionRequested', stage: 'changes', note }]);
  return ok(undefined);
};

export const dropChange = async (deps: Deps, slug: string, changeId: string, note: string): Promise<Result<void, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const can = canDropChange(loaded.value, changeId);
  if (!can.ok) return can;
  await emit(deps, slug, [{ type: 'ChangeDropped', changeId, note }]);
  return ok(undefined);
};

