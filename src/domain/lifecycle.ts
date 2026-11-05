/**
 * Guards: pure checks that decide whether a command is legal in the current state.
 * Use cases call these before doing any side effect.
 */
import { dependentsOf } from './changes.ts';
import { STARTED, stageIndex, type ChangeState, type ChangeStatus, type DocStage, type Epic, type GatedStage } from './epic.ts';
import { err, ok, type Result } from './result.ts';

export type DomainError = { readonly code: string; readonly message: string };

const fail = (code: string, message: string): Result<never, DomainError> => err({ code, message });

const live = (e: Epic): Result<Epic, DomainError> =>
  e.stage === 'done' || e.stage === 'abandoned' ? fail('terminal', `Epic "${e.slug}" is ${e.stage}.`) : ok(e);

/** Which stage a run should execute right now. */
export const runnableStage = (e: Epic): Result<DocStage, DomainError> => {
  const l = live(e);
  if (!l.ok) return l;
  if (e.status === 'running') return fail('already_running', `Stage "${e.stage}" is already running.`);
  if (e.status === 'awaiting_answers')
    return fail('questions_open', `The ${e.stage} agent is waiting for answers to its questions. Answer them to continue.`);
  if (e.stage === 'changes') return ok('changes');
  if (e.status === 'awaiting_approval')
    return fail('gate_open', `The ${e.stage} gate is waiting for approval. Approve or revise it first.`);
  return ok(e.stage as GatedStage);
};

/** The single-document gate (requirements or epic spec) that is open, if any. */
export const openGate = (e: Epic): Result<GatedStage, DomainError> => {
  const l = live(e);
  if (!l.ok) return l;
  if ((e.stage === 'requirements' || e.stage === 'spec') && e.status === 'awaiting_approval') return ok(e.stage);
  return fail('no_gate', `No requirements or epic spec gate is open on "${e.slug}" (stage ${e.stage}, ${e.status}).`);
};

/** A question the agent asked and nobody has answered yet. */
export const canAnswer = (e: Epic, questionId: string): Result<GatedStage, DomainError> => {
  const l = live(e);
  if (!l.ok) return l;
  const q = e.dialog?.questions.find((x) => x.id === questionId);
  if (!e.dialog || !q) return fail('unknown_question', `No question "${questionId}" on "${e.slug}".`);
  if (q.answer) return fail('answered', `${questionId} is already answered.`);
  return ok(e.dialog.stage);
};

/** Plan-level feedback ("split C2", "add a migration change") applies in the changes stage. */
export const canRevisePlan = (e: Epic): Result<Epic, DomainError> => {
  const l = live(e);
  if (!l.ok) return l;
  return e.stage === 'changes' && e.status !== 'running'
    ? ok(e)
    : fail('not_planning', `Plan-level feedback only applies in the change specs stage.`);
};

export const canSendBack = (e: Epic, to: string): Result<GatedStage, DomainError> => {
  const l = live(e);
  if (!l.ok) return l;
  if (to !== 'requirements' && to !== 'spec') return fail('invalid_stage', 'Can only send back to requirements or spec.');
  if (stageIndex(to) > stageIndex(e.stage)) return fail('forward', `"${to}" is ahead of the current stage ${e.stage}.`);
  const started = e.changes.filter((c) => STARTED.includes(c.status) || c.branch);
  if (started.length > 0)
    return fail('started', `Changes already have code: ${started.map((c) => c.id).join(', ')}. Drop or finish them first.`);
  return ok(to);
};

const findChange = (e: Epic, changeId: string): Result<ChangeState, DomainError> => {
  const change = e.changes.find((c) => c.id === changeId);
  return change ? ok(change) : fail('unknown_change', `No change "${changeId}" in "${e.slug}".`);
};

const inStatus = (
  e: Epic,
  changeId: string,
  allowed: readonly ChangeStatus[],
  verb: string,
): Result<ChangeState, DomainError> => {
  const c = findChange(e, changeId);
  if (!c.ok) return c;
  return allowed.includes(c.value.status)
    ? c
    : fail('wrong_status', `Cannot ${verb} ${changeId}: it is ${c.value.status} (needs ${allowed.join(' or ')}).`);
};

/** Approving a draft approves its spec; approving a reviewed change approves its code. */
export type ApprovalTarget = { readonly kind: 'spec' | 'code'; readonly change: ChangeState };

export const approvalTarget = (e: Epic, changeId: string): Result<ApprovalTarget, DomainError> => {
  const c = inStatus(e, changeId, ['draft', 'awaiting_review'], 'approve');
  if (!c.ok) return c;
  return ok({ kind: c.value.status === 'draft' ? 'spec' : 'code', change: c.value });
};

/** Feedback on a draft redrafts its spec; feedback on code reworks the implementation. */
export const revisionTarget = (e: Epic, changeId: string): Result<ApprovalTarget, DomainError> => {
  const c = inStatus(e, changeId, ['draft', 'revising', 'awaiting_review', 'escalated', 'mr_open'], 'revise');
  if (!c.ok) return c;
  return ok({ kind: c.value.status === 'draft' || c.value.status === 'revising' ? 'spec' : 'code', change: c.value });
};

export const canDropChange = (e: Epic, changeId: string): Result<ChangeState, DomainError> => {
  const c = inStatus(e, changeId, ['draft', 'revising', 'ready', 'escalated'], 'drop');
  if (!c.ok) return c;
  if (c.value.mergeRequest) return fail('has_mr', `${changeId} has an MR; close it in GitLab first.`);
  const dependents = dependentsOf(e.changes, changeId);
  return dependents.length > 0
    ? fail('has_dependents', `${dependents.join(', ')} depend on ${changeId}. Drop or revise them first.`)
    : c;
};

/** Changes approved by the review gate but without an MR yet (e.g. a push failed last time). */
export const changesNeedingMergeRequest = (e: Epic): readonly ChangeState[] =>
  e.changes.filter((c) => c.status === 'approved');
