/**
 * Prompt builders. Pure: every input is passed in, nothing is read here.
 */
import type { ApprovedChange, AskedQuestion, ChangeState, Epic, Finding, GatedStage } from '../domain/epic.ts';
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

const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

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
  readonly requirements?: string;
  readonly spec?: string;
  readonly previous?: string;
};

const header = (stage: string, { epic, repos }: DocInputs) => `# Stage: ${stage}

Epic: ${epic.title} (owner ${epic.owner})

## Repositories in scope

${reposList(repos)}

`;

/** Inputs of a stage whose agent may pause with questions for the owner. */
export type AskingInputs = DocInputs & {
  readonly answered: readonly AskedQuestion[];
  /** Question rounds the agent may still use; 0 = it must finish now. */
  readonly roundsLeft: number;
  readonly maxPerRound: number;
};

const qa = (qs: readonly AskedQuestion[]): string =>
  qs.map((q) => `- ${q.id}: ${q.text}\n  Answer (${q.answer?.by}): ${q.answer?.text}`).join('\n');

const WHAT_TO_ASK: Readonly<Record<GatedStage, string>> = {
  requirements:
    'Ask about the product, not the implementation: who it is for, the expected behavior and edge cases, where scope ends, priorities, and constraints the code cannot tell you (deadlines, compliance, compatibility promises).',
  spec: 'Ask technical decisions the requirements and the code do not settle: the shape of a contract between repositories, which of two existing patterns to follow, a migration or rollout strategy, or how to slice the work.',
};

const askingRules = (stage: GatedStage, roundsLeft: number, maxPerRound: number): string =>
  roundsLeft > 0
    ? `## Asking the owner

You can ask the epic's owner with the ask_human tool as you work (up to ${maxPerRound} questions per call, ${roundsLeft} more call${roundsLeft === 1 ? '' : 's'} at most). The run pauses after the call and you are resumed with the answers, so:
- Ask early when an answer changes where you look or what you write. ${WHAT_TO_ASK[stage]}
- Never ask what the code, tests or docs can tell you. Look first.
- Put every question you need right now into one call. For each: a 2-3 word header; the question in one short sentence; why it matters (context and what you found go here); and 2-4 distinct options, each a few-word label plus a one-line description. Mark the one you'd pick as recommended. Then stop and wait.

`
    : `## Asking the owner

You can't ask more questions. Finish with what you know${stage === 'requirements' ? ', and list anything still unresolved under "Open questions"' : ', and state any decision you made on the owner\'s behalf under "Decisions"'}.

`;

const REQUIREMENTS_FORMAT = `Respond with only a markdown document with these sections:

## Problem
Who has the problem, what it is, and why it matters now. A few sentences.

## Users and scenarios
Who is affected, and the main scenarios step by step from their side.

## Current behavior
What the product does today in these scenarios, per repository, citing the files that show it. Facts only, no proposals.

## Functional requirements
Numbered items: "- R1: <what must be true>", each with an indented "- Acceptance: <a checkable criterion>". Say what, never how: no files, modules or designs.

## Non-functional requirements
Numbered items continuing the same sequence (performance, security, compatibility, accessibility, data). "None" if there are none.

## Out of scope
What this epic deliberately does not do.

## Decisions
Each question the owner answered, the answer, and what it changed. "None" if there were none.

## Open questions
Only what is still unresolved, each followed by an empty "Answer:" line. "None" if nothing is.`;

const REQUIREMENTS_TASK = `Analyze what this idea requires. Read the repositories (read-only) only to learn how the product behaves today and what constrains it. Do not design a solution or propose an implementation: that is the next stage, and it builds on what you write here.`;

export const requirementsPrompt = (i: AskingInputs): string => `${header('requirements', i)}${section('Idea', i.idea)}${section('Human guidance', guidance(i.epic))}${section('Already answered by the owner', i.answered.length ? qa(i.answered) : undefined)}${revision(i.epic, i.previous)}${REQUIREMENTS_TASK}

${askingRules('requirements', i.roundsLeft, i.maxPerRound)}When you have what you need, ${lower(REQUIREMENTS_FORMAT)}
`;

const SPEC_FORMAT = `Respond with only a markdown document with these sections:

## Summary
The outcome in one paragraph, and the repositories it touches.

## Approach
How the requirements will be met, only at the depth needed to slice the work: what each repository is responsible for, the contracts between repositories (endpoints, events, payload fields, errors), the data and migration strategy, and the order things must land in. Name modules and areas, not every file.

## Alternatives considered
Other approaches, a line or two each, and why not.

## Decisions
Only if you asked the owner questions: each question, the answer, and what it changed.

## Changes
One subsection per change, in delivery order, exactly like this:

### C1: <short title>
- Repo: <repository name>
- Depends on: <ids of changes that must merge first, or none>
- Requirements: <the requirement ids it delivers, e.g. R1, R3>

One short paragraph: what this change does and where its boundary is.

## Verification
End-to-end checks for the epic as a whole: a list of concrete, checkable items.

## Must not break
A list of existing behaviors, APIs and tests that must keep working.

## Risk
Start with low, medium or high, then one sentence why. High means security, data, money, auth, migrations or public API.

Add a "## Rollout" section only when flags, migrations or deploy order matter.`;

const SLICING_RULES = (max: number) => `Rules for the changes:
- Every requirement is covered by at least one change.
- One change is one merge request in exactly one repository. A contract between repositories is usually two changes: the provider first, then the consumer depending on it.
- One concern per change, small enough to review in one sitting (at most ${max} files each).
- Changes that do not depend on each other should touch different areas, so they can be built in parallel.`;

export const specPrompt = (i: AskingInputs & { readonly maxFilesPerChange: number }): string => `${header('epic spec', i)}${section('Idea', i.idea)}${section('Approved requirements', i.requirements)}${section('Human guidance', guidance(i.epic))}${section('Already answered by the owner', i.answered.length ? qa(i.answered) : undefined)}${revision(i.epic, i.previous)}Write the epic spec: an RFC whose main purpose is to break the epic into changes. Each change becomes one change spec and one merge request; the change specs, written next, carry the file-level detail (exact files, precise behavior, tests). Explore the code as deeply as you need to slice the work correctly and settle the contracts between repositories, and no deeper.

${SLICING_RULES(i.maxFilesPerChange)}

${askingRules('spec', i.roundsLeft, i.maxPerRound)}When you have what you need, ${lower(SPEC_FORMAT)}

Do not leave TODO or TBD text.
`;

const FORMAT: Readonly<Record<GatedStage, string>> = { requirements: REQUIREMENTS_FORMAT, spec: SPEC_FORMAT };

/** Resumes a paused stage session with the owner's answers (and any revision feedback). */
export const continuePrompt = (
  stage: GatedStage,
  answers: readonly AskedQuestion[],
  feedback: readonly string[],
  roundsLeft: number,
  maxPerRound: number,
): string => `${section('The owner answered', answers.length ? qa(answers) : undefined)}${section('Feedback you must address', feedback.length ? bullets(feedback) : undefined)}Continue with this in mind.

${askingRules(stage, roundsLeft, maxPerRound)}When you have what you need, ${lower(FORMAT[stage])}
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

export const changesPrompt = (i: ChangesInputs): string => `${header('change specs', i)}${section('Approved epic spec', i.spec)}${section('Approved requirements', i.requirements)}${section('Human guidance', guidance(i.epic))}${section('Already approved change specs (fixed: do not repeat, change or reuse their ids)', i.approved.map((c) => c.markdown).join('\n\n'))}${section('Current drafts', i.drafts.join('\n\n'))}${section('Feedback you must address', i.epic.pendingFeedback.length ? bullets(i.epic.pendingFeedback) : undefined)}Write one change spec for each change planned in the epic spec's "Changes" section, keeping its id, repository and dependencies. The epic spec settled how the work is sliced; your job is the detail an implementing agent needs: the exact files, precise behavior, and the tests and checks that prove it. Read the code to get this right. Only add, split, merge or drop changes when the feedback asks for it, or when a planned change cannot meet the rules below; then say why in its goal.

Return the complete set of drafts (not the approved ones). Keep a draft's id when you keep that change; use new ids for new changes and never reuse: ${i.reserved.join(', ') || 'none reserved'}.

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
