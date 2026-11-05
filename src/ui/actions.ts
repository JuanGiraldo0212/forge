/**
 * User actions behind the desktop app's buttons. Each calls the use cases and returns a one-line outcome
 * to show the user. No rendering, no front-end state.
 */
import { syncMergeRequests } from '../application/build.ts';
import { approveAllDrafts, approveChange, approveChangeSet, dropChange, reviseChange, revisePlan, runChanges, runDevelopment } from '../application/changes.ts';
import { loadEpic, type Deps } from '../application/deps.ts';
import { abandon, answerQuestions, approveStage, assignOwner, createEpic, reviseStage, runGatedStage, runnable, sendBack } from '../application/stages.ts';
import { STAGE_LABEL, type Epic } from '../domain/epic.ts';
import type { Result } from '../domain/result.ts';

export type Tone = 'info' | 'success' | 'error';

export type Outcome = { readonly ok: boolean; readonly text: string; readonly tone: Tone; readonly select?: string };

const done = (text: string, tone: Tone = 'success', select?: string): Outcome => ({ ok: tone !== 'error', text, tone, select });
const failed = (text: string): Outcome => done(text.split('\n').join(' '), 'error');

const fromResult = <T>(r: Result<T, { readonly message: string }>, text: (v: T) => string): Outcome =>
  r.ok ? done(text(r.value)) : failed(r.error.message);

/** Every epic, most recently updated first. */
export const loadAll = async (deps: Deps): Promise<readonly Epic[]> => {
  const slugs = await deps.epics.list();
  const loaded = await Promise.all(slugs.map((s) => loadEpic(deps, s)));
  return loaded.flatMap((r) => (r.ok ? [r.value] : [])).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const createEpicAction = async (deps: Deps, title: string, idea: string): Promise<Outcome> => {
  const created = await createEpic(deps, title, idea || title);
  return created.ok
    ? done(`Created "${created.value}" (owner ${deps.actor}). Run it to start the requirements analysis.`, 'success', created.value)
    : failed(created.error.message);
};

export const runAction = async (deps: Deps, slug: string, force: boolean): Promise<Outcome> => {
  const target = await runnable(deps, slug, force);
  if (!target.ok) return failed(target.error.message);
  const { epic, stage } = target.value;
  if (stage === 'changes') {
    const r = await runChanges(deps, epic);
    if (!r.ok) return failed(r.error.message);
    const parts = [
      r.value.drafted.length ? `Drafted ${r.value.drafted.join(', ')}: review and approve each change spec` : '',
      r.value.revised.length ? `redrafted ${r.value.revised.join(', ')}` : '',
      ...r.value.errors,
    ].filter(Boolean);
    return done(parts.join(' · ') || 'Nothing to draft.', r.value.errors.length > 0 ? 'error' : 'info');
  }
  if (stage === 'development') {
    const r = await runDevelopment(deps, epic, force);
    if (!r.ok) return failed(r.error.message);
    const parts = [...r.value.outcomes.map((o) => `${o.changeId}: ${o.result}${o.detail ? ` (${o.detail})` : ''}`), r.value.outcomes.length ? '' : (r.value.idle ?? '')].filter(Boolean);
    const bad = r.value.outcomes.some((o) => o.result === 'failed' || o.result === 'escalated');
    return done(parts.join(' · ') || 'Nothing to build.', bad ? 'error' : 'info');
  }
  const run = await runGatedStage(deps, epic, stage);
  if (!run.ok) return failed(run.error.message);
  if (run.value.kind === 'questions')
    return done(
      `The ${STAGE_LABEL[stage]} agent has ${run.value.questions.length} question${run.value.questions.length > 1 ? 's' : ''} for you: ${run.value.questions.map((q) => `${q.id}: ${q.text}`).join(' · ')}`,
      'info',
    );
  return run.value.issues.length
    ? done(`${STAGE_LABEL[stage]} ready, but it can't be approved yet: ${run.value.issues.join('; ')}`, 'error')
    : done(`${STAGE_LABEL[stage]} ready for your review.`);
};

/** Approves the open gate, or one change (its spec when a draft, its code when reviewed). */
export const approveAction = async (deps: Deps, slug: string, changeId: string | undefined, note: string): Promise<Outcome> => {
  const n = note.trim() || undefined;
  if (changeId) {
    const r = await approveChange(deps, slug, changeId, n);
    if (!r.ok) return failed(r.error.message);
    if (r.value.kind === 'spec') return done(`Approved change spec ${r.value.changeId}.`);
    // The approval is recorded either way; opening the MR can still fail (push, token, GitLab).
    const o = r.value.outcome;
    return o.result === 'mr_open'
      ? done(`${o.changeId}: MR opened — ${o.detail}`)
      : failed(`${o.changeId}: code approved, but the MR did not open: ${o.detail}. The next run retries.`);
  }
  const loaded = await loadEpic(deps, slug);
  if (loaded.ok && loaded.value.stage === 'changes')
    return fromResult(await approveChangeSet(deps, slug, n), (r) =>
      [
        'Change set approved. Development starts: run it to build the changes.',
        r.missing.length ? `Planned in the epic spec but without a change spec: ${r.missing.join(', ')}.` : '',
        r.unplanned.length ? `Not in the epic spec's plan: ${r.unplanned.join(', ')}.` : '',
      ].filter(Boolean).join(' '),
    );
  return fromResult(await approveStage(deps, slug, n), (stage) => `Approved ${STAGE_LABEL[stage]}. Run the next stage when ready.`);
};

export const approveAllAction = async (deps: Deps, slug: string, note: string): Promise<Outcome> =>
  fromResult(await approveAllDrafts(deps, slug, note.trim() || undefined), (r) =>
    [r.approved.length ? `Approved ${r.approved.join(', ')}.` : 'Nothing approved.', ...r.blocked.map((b) => b.split('\n').join(' '))].join(' · '),
  );

/** Feedback on one change (spec or code), on the whole change set, or on the open gate. */
export const reviseAction = async (deps: Deps, slug: string, changeId: string | undefined, note: string): Promise<Outcome> => {
  if (changeId)
    return fromResult(await reviseChange(deps, slug, changeId, note), (kind) =>
      kind === 'spec' ? `${changeId}'s spec will be redrafted on the next run.` : `${changeId}'s code will be reworked on the next run.`,
    );
  const epic = await loadEpic(deps, slug);
  if (epic.ok && epic.value.stage === 'changes')
    return fromResult(await revisePlan(deps, slug, note), () => 'Unapproved change specs will be redrafted on the next run.');
  return fromResult(await reviseStage(deps, slug, note), (stage) => `${STAGE_LABEL[stage]} will be regenerated on the next run.`);
};

/**
 * Records answers; once none are left open, resumes the paused agent straight away so the stage
 * carries on as a conversation.
 */
export const answerAction = async (
  deps: Deps,
  slug: string,
  answers: readonly { readonly questionId: string; readonly text: string }[],
  continueRun = true,
): Promise<Outcome> => {
  const r = await answerQuestions(deps, slug, answers);
  if (!r.ok) return failed(r.error.message);
  if (r.value.remaining.length) return done(`Answered. Still open: ${r.value.remaining.join(', ')}.`, 'info');
  return continueRun ? runAction(deps, slug, false) : done('Answered. Run the agent to continue.', 'success');
};

export const sendBackAction = async (deps: Deps, slug: string, to: string, note: string): Promise<Outcome> =>
  fromResult(await sendBack(deps, slug, to, note), (stage) => `Back to ${STAGE_LABEL[stage]}. Run it again when ready.`);

export const dropAction = async (deps: Deps, slug: string, changeId: string, note: string): Promise<Outcome> =>
  fromResult(await dropChange(deps, slug, changeId, note), () => `Dropped ${changeId}.`);

export const assignAction = async (deps: Deps, slug: string, owner: string): Promise<Outcome> =>
  fromResult(await assignOwner(deps, slug, owner), (o) => `Owner is now ${o}.`);

export const abandonAction = async (deps: Deps, slug: string, note: string): Promise<Outcome> =>
  fromResult(await abandon(deps, slug, note), () => `Abandoned "${slug}".`);

export const syncAction = async (deps: Deps, slug: string): Promise<Outcome> => {
  const rows = await syncMergeRequests(deps, slug);
  if (!rows.ok) return failed(rows.error.message);
  if (rows.value.length === 0) return done('No open MRs.', 'info');
  return done(
    rows.value.map((r) => ('error' in r ? `${r.changeId}: ${r.error}` : `${r.changeId}: ${r.state}${r.pipeline ? ` (${r.pipeline})` : ''}`)).join(' · '),
    rows.value.some((r) => 'error' in r) ? 'error' : 'info',
  );
};
