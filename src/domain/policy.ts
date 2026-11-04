/**
 * Loop limits and gate policy. Pure.
 */
import type { Finding, Risk } from './epic.ts';

export type LoopPolicy = { readonly maxRounds: number; readonly maxIdenticalFailures: number };

/** Strips the noise that makes two identical failures look different (timings, ids, colors). */
export const failureSignature = (checkName: string, output: string): string => {
  const tail = output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<hash>')
    .replace(/\d+(\.\d+)?/g, '#')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-40)
    .join('\n');
  return `${checkName}\n${tail}`;
};

/** Returns why the loop must stop and hand over to a human, or undefined to keep going. */
export const escalationReason = (policy: LoopPolicy, failures: readonly string[]): string | undefined => {
  if (failures.length >= policy.maxRounds) return `hit ${policy.maxRounds} rounds without green checks`;
  const n = policy.maxIdenticalFailures;
  const last = failures.slice(-n);
  if (last.length === n && last.every((s) => s === last[0]))
    return `same failure ${n} times in a row (${last[0]?.split('\n')[0]})`;
  return undefined;
};

/**
 * The Agent SDK reports a running total for a resumed session. This converts it to the spend of one run,
 * given the total last seen for that session (undefined for a fresh session).
 * A total below the baseline means the SDK started counting from zero (no saved total, or a zeroed
 * crash result), so the reported number is this run's spend on its own.
 */
export const runCost = (reportedTotal: number, baseline: number | undefined): number =>
  baseline === undefined || reportedTotal < baseline ? reportedTotal : reportedTotal - baseline;

export type ReviewGatePolicy = 'always' | 'risk-based';

/** `risk-based` skips the human review gate only for low/medium risk tasks with no blocking findings. */
export const reviewGateRequired = (policy: ReviewGatePolicy, risk: Risk, findings: readonly Finding[]): boolean =>
  policy === 'always' || risk === 'high' || findings.some((f) => f.severity === 'blocking');

/** Kinds where a test must fail without the change. Refactors and chores should keep tests green either way. */
export const needsRevertTest = (kind: string): boolean => kind === 'feature' || kind === 'fix';
