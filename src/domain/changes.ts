/**
 * Change specs: one markdown file per change, one change per merge request. Pure.
 *
 *   ---
 *   id: C1
 *   title: Add dueDate to the todo model
 *   repo: backend
 *   kind: feature
 *   risk: low
 *   files: [src/todos.ts, src/todos.test.ts]
 *   dependsOn: []
 *   ---
 *   ## Goal / ## Behavior / ## Verification / ## Must not break
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ApprovedChange, ChangeState } from './epic.ts';
import { err, ok, type Result } from './result.ts';
import { listItems, PLACEHOLDER, sections } from './spec.ts';

export const CHANGE_SECTIONS = ['Goal', 'Behavior', 'Verification', 'Must not break'] as const;

export const ChangeHeaderSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'id must be alphanumeric, "-" or "_"'),
  title: z.string().min(1),
  repo: z.string().min(1),
  kind: z.enum(['feature', 'fix', 'refactor', 'test', 'chore']),
  risk: z.enum(['low', 'medium', 'high']),
  files: z.array(z.string().min(1)).min(1, 'declare the files the change expects to touch'),
  dependsOn: z.array(z.string()).default([]),
});

export type ChangeHeader = z.infer<typeof ChangeHeaderSchema>;

/** What a drafting agent returns for one change; rendered to a file for humans to edit. */
export type ChangeDraft = ChangeHeader & {
  readonly goal: string;
  readonly behavior: string;
  readonly verification: readonly string[];
  readonly mustNotBreak: readonly string[];
};

/** JSON strings and arrays are valid YAML, which keeps titles and paths safely quoted. */
export const renderChangeSpec = (d: ChangeDraft): string => `---
id: ${d.id}
title: ${JSON.stringify(d.title)}
repo: ${d.repo}
kind: ${d.kind}
risk: ${d.risk}
files: ${JSON.stringify(d.files)}
dependsOn: ${JSON.stringify(d.dependsOn)}
---

## Goal

${d.goal.trim()}

## Behavior

${d.behavior.trim()}

## Verification

${d.verification.map((v) => `- ${v}`).join('\n')}

## Must not break

${d.mustNotBreak.map((v) => `- ${v}`).join('\n')}
`;

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** Parses and lints one change spec file. `fileId` is the id implied by the file name. */
export const parseChangeSpec = (markdown: string, fileId: string): Result<ApprovedChange, readonly string[]> => {
  const fm = markdown.match(FRONTMATTER);
  if (!fm) return err(['missing the --- frontmatter block at the top']);

  let raw: unknown;
  try {
    raw = parseYaml(fm[1] ?? '');
  } catch (e) {
    return err([`frontmatter is not valid YAML: ${(e as Error).message}`]);
  }
  const header = ChangeHeaderSchema.safeParse(raw);
  const body = markdown.slice(fm[0].length);
  const s = sections(body);
  const verification = listItems(s.get('verification') ?? '');

  const issues = [
    ...(header.success ? [] : header.error.issues.map((i) => `frontmatter ${i.path.join('.') || '(root)'}: ${i.message}`)),
    ...(typeof (raw as { id?: unknown } | null)?.id === 'string' && (raw as { id: string }).id !== fileId
      ? [`frontmatter id "${(raw as { id: string }).id}" does not match the file name (${fileId})`]
      : []),
    ...CHANGE_SECTIONS.filter((name) => !s.get(name.toLowerCase())).map((name) => `missing or empty section "## ${name}"`),
    ...(s.get('verification') && verification.length === 0 ? ['"Verification" needs at least one list item'] : []),
    ...(s.get('must not break') && listItems(s.get('must not break') ?? '').length === 0
      ? ['"Must not break" needs at least one list item']
      : []),
    ...(PLACEHOLDER.test(body) ? ['change spec still contains TODO/TBD or <placeholder> text'] : []),
  ];
  if (issues.length > 0 || !header.success) return err(issues);
  return ok({ ...header.data, verification, markdown });
};

export type ChangeLimits = { readonly maxFilesPerChange: number; readonly repos: readonly string[] };

type Node = { readonly id: string; readonly dependsOn: readonly string[] };

/** Kahn's algorithm; returns the ids left over when there is a cycle. */
const findCycle = (nodes: readonly Node[]): readonly string[] => {
  const indegree = new Map(nodes.map((n) => [n.id, n.dependsOn.length]));
  const queue = nodes.filter((n) => n.dependsOn.length === 0).map((n) => n.id);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    seen.add(id);
    for (const n of nodes) {
      if (!n.dependsOn.includes(id)) continue;
      const d = (indegree.get(n.id) ?? 0) - 1;
      indegree.set(n.id, d);
      if (d === 0) queue.push(n.id);
    }
  }
  return nodes.map((n) => n.id).filter((id) => !seen.has(id));
};

/**
 * Checks one change against the epic's other live changes: known repo, file limit,
 * dependencies that exist and are not dropped, and no cycles.
 */
export const validateChange = (
  candidate: ApprovedChange,
  others: readonly Node[],
  limits: ChangeLimits,
): Result<ApprovedChange, readonly string[]> => {
  const ids = new Set(others.map((o) => o.id));
  const issues = [
    ...(limits.repos.includes(candidate.repo) ? [] : [`repo "${candidate.repo}" is not configured (known: ${limits.repos.join(', ')})`]),
    ...(candidate.files.length > limits.maxFilesPerChange
      ? [`touches ${candidate.files.length} files (limit ${limits.maxFilesPerChange}); split it`]
      : []),
    ...candidate.dependsOn.filter((d) => !ids.has(d)).map((d) => `depends on unknown or dropped change ${d}`),
    ...(candidate.dependsOn.includes(candidate.id) ? ['depends on itself'] : []),
  ];
  if (issues.length > 0) return err(issues);
  const cycle = findCycle([...others.filter((o) => o.id !== candidate.id), candidate]);
  return cycle.length > 0 ? err([`dependency cycle among: ${cycle.join(', ')}`]) : ok(candidate);
};

/** Validates a freshly drafted set before it is written: unique ids that do not collide with approved ones. */
export const validateDraftSet = (
  drafts: readonly ChangeDraft[],
  reserved: readonly string[],
): Result<readonly ChangeDraft[], readonly string[]> => {
  const ids = drafts.map((d) => d.id);
  const issues = [
    ...(drafts.length === 0 ? ['the agent proposed no changes'] : []),
    ...ids.filter((id, i) => ids.indexOf(id) !== i).map((id) => `duplicate change id ${id}`),
    ...ids.filter((id) => reserved.includes(id)).map((id) => `change id ${id} is already approved or dropped; use a new id`),
    ...drafts.flatMap((d) => (ChangeHeaderSchema.safeParse(d).success ? [] : [`change ${d.id}: invalid header fields`])),
  ];
  return issues.length > 0 ? err(issues) : ok(drafts);
};

/**
 * Dependents wait until their dependencies are merged into their repo's base branch.
 * Slower than stacked branches, but every change branches from reviewed, merged code.
 */
export const readyChanges = (changes: readonly ChangeState[]): readonly ChangeState[] => {
  const merged = new Set(changes.filter((c) => c.status === 'merged').map((c) => c.id));
  return changes.filter((c) => c.status === 'ready' && c.spec && c.spec.dependsOn.every((d) => merged.has(d)));
};

const overlaps = (a: ApprovedChange, b: ApprovedChange): boolean =>
  a.repo === b.repo && a.files.some((f) => b.files.includes(f));

/** Greedy batch of ready changes whose declared files do not overlap in the same repo. */
export const selectBatch = (ready: readonly ChangeState[], maxParallel: number): readonly ChangeState[] =>
  ready.reduce<readonly ChangeState[]>(
    (batch, c) =>
      batch.length < maxParallel && !batch.some((b) => overlaps(b.spec!, c.spec!)) ? [...batch, c] : batch,
    [],
  );

/** Files the agent changed that the change spec did not declare. Surfaced to the reviewer and the human. */
export const undeclaredChanges = (spec: ApprovedChange, changed: readonly string[]): readonly string[] =>
  changed.filter((f) => !spec.files.includes(f));

/** Live changes that list `changeId` as a dependency. */
export const dependentsOf = (changes: readonly ChangeState[], changeId: string): readonly string[] =>
  changes.filter((c) => c.status !== 'dropped' && c.spec?.dependsOn.includes(changeId)).map((c) => c.id);
