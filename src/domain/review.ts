/**
 * The review loop, Devin-style but with every round counted: the reviewer's findings go back to the author before a
 * human looks, and an open MR's threads and failed pipelines go back to the author while the MR waits. Pure.
 */
import { unresolved, type ChangeState, type Finding, type FindingStatus, type MergeRequestFeedbackItem } from './epic.ts';

export type Severity = Finding['severity'];

/** Which findings the author fixes on its own before the human gate, and for how many rounds. */
export type AutofixPolicy = { readonly severities: readonly Severity[]; readonly maxRounds: number };

/** What a later review says about a finding it was shown. */
export type Verdict = { readonly id: string; readonly status: 'open' | 'fixed' | 'invalid'; readonly note?: string };

const findingNumber = (id: string | undefined): number => Number(id?.match(/^F(\d+)$/)?.[1] ?? 0);

/**
 * The findings after a review: earlier ones updated by the reviewer's verdicts, then the new ones, numbered on from
 * the highest id so far. A finding the owner dismissed stays dismissed. A finding the reviewer did not mention keeps
 * its state: an open one is not silently dropped.
 */
export const mergeReview = (
  previous: readonly Finding[],
  verdicts: readonly Verdict[],
  fresh: readonly Finding[],
): readonly Finding[] => {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const updated = previous.map((f): Finding => {
    const v = f.id ? byId.get(f.id) : undefined;
    if (!v || f.status === 'invalid') return f;
    // A question for the owner is the owner's to settle, unless the code no longer has the problem.
    if (f.status === 'needs_input' && v.status === 'open') return f;
    const status: FindingStatus = v.status;
    return { ...f, status, note: v.note ?? f.note };
  });
  let next = Math.max(0, ...previous.map((f) => findingNumber(f.id)));
  return [...updated, ...fresh.map((f): Finding => ({ ...f, id: `F${++next}`, status: 'open' }))];
};

/** Findings the author should fix now. */
export const autofixTargets = (policy: AutofixPolicy, findings: readonly Finding[]): readonly Finding[] =>
  findings.filter((f) => (f.status === undefined || f.status === 'open') && policy.severities.includes(f.severity));

/**
 * Why the automatic fix rounds stop with targets left, or undefined to run another. `round` is how many fix rounds
 * already ran; `previous` are the targets of the last one.
 */
export const autofixStop = (
  policy: AutofixPolicy,
  round: number,
  targets: readonly Finding[],
  previous: readonly Finding[] | undefined,
): string | undefined => {
  if (targets.length === 0) return undefined;
  if (round >= policy.maxRounds) return `${targets.length} finding${targets.length > 1 ? 's' : ''} still open after ${round} automatic fix round${round === 1 ? '' : 's'}`;
  const key = (fs: readonly Finding[]) => fs.map((f) => f.id).sort().join(',');
  if (previous && key(previous) === key(targets)) return `the automatic fix round left the same findings open (${key(targets)})`;
  return undefined;
};

/** Findings a person has to see: open, disputed or waiting on the owner. */
export const findingsToSettle = (findings: readonly Finding[]): readonly Finding[] => findings.filter(unresolved);

/** Questions the author raised on findings since `before` (the findings when its run started). */
export const newFindingQuestions = (findings: readonly Finding[], before: readonly Finding[]): readonly string[] => {
  const asked = new Set(before.filter((f) => f.status === 'needs_input').map((f) => f.id));
  return findings
    .filter((f) => f.status === 'needs_input' && !asked.has(f.id))
    .map((f) => `${f.id ?? 'finding'} (${f.summary}): ${f.note ?? ''}`.trim());
};

/** Questions the author answered MR feedback with: only the owner can settle them. */
export const mergeRequestQuestions = (change: ChangeState): readonly string[] =>
  (change.mergeRequestFeedback?.responses ?? []).filter((r) => r.outcome === 'needs_input').map((r) => `${r.id}: ${r.reply}`);

/** Limits on reworking an open MR without a human. */
export type MergeRequestPolicy = {
  readonly maxAutoReworks: number;
  readonly maxSpendUsd: number;
  readonly ciFixRounds: number;
};

/**
 * Why new MR feedback must wait for the owner instead of being reworked automatically, or undefined to go ahead.
 * A human acting on the change (rework, approval) starts the count again.
 */
export const autoReworkHold = (
  policy: MergeRequestPolicy,
  change: ChangeState,
  items: readonly MergeRequestFeedbackItem[],
): string | undefined => {
  // No automatic rework since a human acted: the counts start from nothing (a limit of 0 still holds everything).
  const a = change.automation ?? { rounds: 0, ciRounds: 0, baselineCostUsd: change.costUsd ?? 0 };
  const what = items.map((i) => (i.kind === 'ci' ? `failed pipeline #${i.pipelineId}` : `a thread by ${i.thread.at(-1)?.author ?? 'someone'}`)).join(', ');
  const hold = (why: string) => `New MR feedback (${what}) waits for you: ${why}.`;
  if (a.rounds >= policy.maxAutoReworks)
    return hold(policy.maxAutoReworks === 0 ? 'automatic reworks are off (mergeRequests.maxAutoReworks: 0)' : `forge already reworked this MR ${a.rounds} times on its own`);
  const spent = (change.costUsd ?? 0) - a.baselineCostUsd;
  if (spent >= policy.maxSpendUsd && (spent > 0 || policy.maxSpendUsd === 0)) return hold(`automatic reworks spent $${spent.toFixed(2)} (limit $${policy.maxSpendUsd.toFixed(2)})`);
  const ci = items.find((i) => i.kind === 'ci');
  if (ci?.kind === 'ci') {
    if (a.ciRounds >= policy.ciFixRounds)
      return hold(policy.ciFixRounds === 0 ? 'automatic pipeline fixes are off (mergeRequests.ciFix.maxRounds: 0)' : `the pipeline failed again after ${a.ciRounds} automatic fix${a.ciRounds === 1 ? '' : 'es'}`);
    if (a.lastCiSignature === ci.signature) return hold('the pipeline failed the same way after the last automatic fix');
  }
  return undefined;
};

/** Marks every comment forge posts, so the watcher never takes forge's own words as a request. */
export const FORGE_MARK = '<!-- forge -->';

/** forge wrote it: marked, or a review comment from before the mark existed. */
export const isForgeNote = (body: string): boolean =>
  body.includes(FORGE_MARK) || /Forge automated review of [0-9a-f]{8}/.test(body);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The note asks for forge by name: the mention on its own, not inside a longer word or address. */
export const mentions = (body: string, mention: string): boolean =>
  new RegExp(`(^|[^\\w.@/-])${escapeRegExp(mention)}(?![\\w-])`, 'i').test(body);
