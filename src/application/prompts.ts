/**
 * Prompt builders. Pure: every input is passed in, nothing is read here.
 */
import type { ApprovedChange, ChangeState, Epic, Finding } from '../domain/epic.ts';
import { REQUIRED_SECTIONS } from '../domain/spec.ts';
import type { CheckResult } from '../ports/index.ts';

export type RepoRef = {
  readonly name: string;
  readonly root: string;
  readonly project: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly source?: 'snapshot' | 'stale-snapshot' | 'working-copy';
};

const section = (title: string, body: string | undefined): string =>
  body && body.trim() ? `## ${title}\n\n${body.trim()}\n\n` : '';

const bullets = (items: readonly string[]): string => items.map((i) => `- ${i}`).join('\n');

const tail = (text: string, max: number): string =>
  text.length <= max ? text : `[... ${text.length - max} chars truncated ...]\n${text.slice(-max)}`;

export const systemPrompt = (instructions: string): string =>
  [
    'You are a stage agent inside Forge, a development harness with human approval gates.',
    'A human reviews everything you produce before it moves on. When you are unsure, say so and ask, rather than guessing.',
    'Read the AGENTS.md (or CLAUDE.md) in any directory you work in before changing it.',
    instructions.trim() ? `\n# Team and repository instructions\n\n${instructions.trim()}` : '',
  ].join('\n');

const freshness = (r: RepoRef): string =>
  r.source === 'snapshot'
    ? `snapshot of ${r.ref} at ${r.commit?.slice(0, 8)}`
    : r.source === 'stale-snapshot'
      ? `last snapshot of ${r.ref} at ${r.commit?.slice(0, 8)}; it could not be refreshed, so recent changes may be missing`
      : r.source === 'working-copy'
        ? `a developer's working copy; it may not match ${r.ref}`
        : '';

const reposList = (repos: readonly RepoRef[]): string =>
  `${bullets(repos.map((r) => `${r.name}: ${r.root} (GitLab ${r.project}${freshness(r) ? `; ${freshness(r)}` : ''})`))}

Read each repository's code only from the path above.`;

const guidance = (e: Epic): string =>
  bullets(e.notes.filter((n) => n.kind === 'approve' && !n.changeId).map((n) => `(${n.stage}) ${n.text}`));

const revision = (e: Epic, previous: string | undefined): string =>
  e.pendingFeedback.length === 0
    ? ''
    : section('Previous version', previous) + section('Feedback you must address in this revision', bullets(e.pendingFeedback));

export type DocInputs = {
  readonly epic: Epic;
  readonly idea: string;
  readonly repos: readonly RepoRef[];
  readonly exploration?: string;
  readonly spec?: string;
  readonly previous?: string;
};

const header = (stage: string, { epic, repos }: DocInputs) => `# Stage: ${stage}

Epic: ${epic.title} (owner ${epic.owner})

## Repositories in scope

${reposList(repos)}

`;

export const explorePrompt = (i: DocInputs): string => `${header('explore', i)}${section('Idea', i.idea)}${section('Human guidance', guidance(i.epic))}${revision(i.epic, i.previous)}Investigate the repositories (read-only) to understand what this epic means across them. Do not design the final solution yet.

Respond with only a markdown document with these sections:

## Summary
What the epic means here, in a few sentences, and which repositories it touches.

## Relevant code
Per repository: file paths with a one-line role each.

## Constraints and invariants
Existing behavior, contracts between repositories (APIs, events, schemas) and tests that must keep working.

## Options
One to three approaches with tradeoffs. Mark the one you recommend and why.

## Risks

## Open questions
Numbered questions only a human can answer, each followed by an empty "Answer:" line for the human to fill in.
`;

export const specPrompt = (i: DocInputs): string => `${header('epic spec', i)}${section('Idea', i.idea)}${section('Exploration (with human answers)', i.exploration)}${section('Human guidance', guidance(i.epic))}${revision(i.epic, i.previous)}Write the epic spec: the whole outcome across every repository. Change specs (one per merge request) are derived from it next, and the agents that implement them see this spec, so be precise.

Respond with only a markdown document with exactly these sections: ${REQUIRED_SECTIONS.map((s) => `"## ${s}"`).join(', ')}.

- Goal: the outcome, in one paragraph.
- Non-goals: what this epic deliberately does not do.
- Behavior: the observable behavior after the epic, per repository where it differs, including contracts between them (endpoints, payloads, errors) and edge cases.
- Verification: a list of concrete, checkable items (tests, commands, observable results).
- Must not break: a list of existing behaviors, APIs and tests that must keep working.
- Risk: start with low, medium or high, then one sentence why. High means security, data, money, auth, migrations or public API.

Do not leave TODO or TBD text. Put anything unresolved in Non-goals, or state the open decision in Behavior explicitly.
`;

export type ChangesInputs = DocInputs & {
  readonly approved: readonly ApprovedChange[];
  readonly drafts: readonly string[];
  readonly reserved: readonly string[];
  readonly maxFilesPerChange: number;
};

const CHANGE_RULES = (max: number) => `Rules for every change spec:
- One change is one merge request in exactly one repository ("repo"). A contract between repositories is usually two changes: the provider first, then the consumer depending on it.
- One concern per change. At most ${max} files. List every file it will create or change in "files" (exact paths relative to that repository's root).
- Changes that do not depend on each other must not share files in the same repository, so they can run in parallel without merge conflicts.
- "dependsOn" lists changes that must be merged first (in any repository).
- goal: one paragraph. behavior: the observable behavior this change adds, precise enough for an agent that only sees the epic spec and this change.
- verification: concrete checks (test names to add, commands, observable results). mustNotBreak: what must keep working, including the epic's "Must not break" items that apply here.
- kind: feature | fix | refactor | test | chore. feature and fix changes must add a test that fails without the change.
- risk: low | medium | high.`;

export const changesPrompt = (i: ChangesInputs): string => `${header('change specs', i)}${section('Approved epic spec', i.spec)}${section('Exploration', i.exploration)}${section('Human guidance', guidance(i.epic))}${section('Already approved change specs (fixed: do not repeat, change or reuse their ids)', i.approved.map((c) => c.markdown).join('\n\n'))}${section('Current drafts', i.drafts.join('\n\n'))}${section('Feedback you must address', i.epic.pendingFeedback.length ? bullets(i.epic.pendingFeedback) : undefined)}Break the epic into change specs. Return the complete set of drafts (not the approved ones). Keep a draft's id when you keep that change; use new ids (C1, C2, ...) for new changes and never reuse: ${i.reserved.join(', ') || 'none reserved'}.

${CHANGE_RULES(i.maxFilesPerChange)}

Return JSON: {"changes": [...]}.
`;

export type ReviseChangeInputs = DocInputs & {
  readonly current: string;
  readonly feedback: readonly string[];
  readonly others: readonly string[];
  readonly maxFilesPerChange: number;
};

export const reviseChangePrompt = (i: ReviseChangeInputs): string => `${header('change spec revision', i)}${section('Approved epic spec', i.spec)}${section('Other change specs in this epic (for context only)', i.others.join('\n\n'))}${section('Change spec to revise', i.current)}${section('Feedback you must address', bullets(i.feedback))}Revise this one change spec. Keep its id.

${CHANGE_RULES(i.maxFilesPerChange)}

Return JSON: {"changes": [<the revised change>]}.
`;

export const changesSchema = (repoNames: readonly string[]): Record<string, unknown> => ({
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          repo: { type: 'string', enum: [...repoNames] },
          kind: { type: 'string', enum: ['feature', 'fix', 'refactor', 'test', 'chore'] },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          files: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
          goal: { type: 'string' },
          behavior: { type: 'string' },
          verification: { type: 'array', items: { type: 'string' } },
          mustNotBreak: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'repo', 'kind', 'risk', 'files', 'dependsOn', 'goal', 'behavior', 'verification', 'mustNotBreak'],
        additionalProperties: false,
      },
    },
  },
  required: ['changes'],
  additionalProperties: false,
});

export type BuildInputs = {
  readonly epicSpec: string;
  readonly change: ChangeState & { readonly spec: ApprovedChange };
  readonly repo: string;
  readonly checks: readonly string[];
  readonly testGlobs: readonly string[];
  readonly revertTestRequired: boolean;
};

const priorFindings = (findings: readonly Finding[]): string =>
  bullets(findings.map((f) => `[${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.summary}`));

export const buildPrompt = ({ epicSpec, change, repo, checks, testGlobs, revertTestRequired }: BuildInputs): string => `# Stage: build — change ${change.id} in repository "${repo}"

${section('Epic spec (the whole epic; you implement only your change)', epicSpec)}## Your change spec

${change.spec.markdown.trim()}

${section('Reviewer findings from the previous attempt', change.findings.length ? priorFindings(change.findings) : undefined)}${section('Human feedback you must address', change.feedback.length ? bullets(change.feedback) : undefined)}Rules:
- You are in a git worktree of "${repo}". Stay within the files listed in the change spec. If you truly must touch another file, do it and explain why in your final message.
- Do not commit, push, or change git configuration. Forge commits for you.
- Never delete, skip or weaken an existing test or assertion to make checks pass.
${revertTestRequired ? `- Write the test first. Forge reverts your non-test changes and re-runs the tests: they must FAIL without your change. Test files match: ${testGlobs.join(', ')}.\n` : ''}- Before finishing, run these checks yourself and make them pass:
${bullets(checks.map((c) => `\`${c}\``))}

Finish with a short summary of what you changed and anything the reviewer should look at closely.
`;

export const checksFailedPrompt = (failed: readonly CheckResult[]): string => `Forge ran the checks and they failed. Fix the cause. Do not weaken or skip tests.

${failed.map((c) => `## ${c.name}\n\n\`\`\`\n${tail(c.output, 8000)}\n\`\`\``).join('\n\n')}
`;

export const revertTestFailedPrompt = (checkName: string): string =>
  `Revert test failed: with your non-test changes reverted, "${checkName}" still passed. Your tests do not prove the change. Add or strengthen a test that fails without your change and passes with it.`;

export const missingTestPrompt = (kind: string, testGlobs: readonly string[]): string =>
  `This is a ${kind} change, so it needs at least one new or changed test file (matching ${testGlobs.join(', ')}). None changed. Add a test that fails without your change.`;

export type ReviewInputs = {
  readonly epicSpec: string;
  readonly change: ChangeState & { readonly spec: ApprovedChange };
  readonly diff: string;
  readonly undeclared: readonly string[];
  readonly revertTest: 'passed' | 'skipped';
};

export const reviewPrompt = ({ epicSpec, change, diff, undeclared, revertTest }: ReviewInputs): string => `# Stage: review — change ${change.id} in "${change.spec.repo}"

You are reviewing another agent's change. You did not write it. Find real defects; do not praise or restate the change.

${section('Epic spec', epicSpec)}## Change spec under review

${change.spec.markdown.trim()}

- Revert test: ${revertTest === 'passed' ? 'passed (tests fail without the change)' : 'not required for this change kind'}
- Files changed outside the change spec: ${undeclared.length ? undeclared.join(', ') : 'none'}

## Diff

\`\`\`diff
${tail(diff, 150_000)}
\`\`\`

You may read files in the working directory for context.

Severity:
- blocking: incorrect behavior, change spec or "Must not break" violation, broken contract with another repository, security issue, data loss, behavior without a test, unexplained changes outside the spec.
- advisory: everything else worth a human's attention. Skip pure style nits.

Return JSON: {"findings": [...]} — an empty list if the change is correct.
`;

export const FINDINGS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocking', 'advisory'] },
          summary: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          detail: { type: 'string' },
        },
        required: ['severity', 'summary'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

/** Drops chatter before the first heading, in case the agent adds a preamble. */
export const extractMarkdown = (text: string): string => {
  const i = text.search(/^#{1,2}\s/m);
  return (i >= 0 ? text.slice(i) : text).trim() + '\n';
};

/** Structured output first; fall back to the first JSON object in the text. */
export const extractJson = (structured: unknown, text: string): unknown => {
  if (structured !== undefined && structured !== null) return structured;
  try {
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '');
  } catch {
    return undefined;
  }
};
