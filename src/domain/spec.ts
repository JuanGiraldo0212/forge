/**
 * Lint for the two planning documents. Neither can pass its gate until it is complete. Pure.
 *
 * - requirements.md: what the epic must achieve, as numbered requirements (R1, R2, ...). No design.
 * - epic-spec.md: an RFC whose main output is the breakdown into changes (C1, C2, ...), each in one
 *   repository, that together cover every requirement. Change specs add the file-level detail later.
 */
import type { Risk } from './epic.ts';
import { findCycle } from './graph.ts';
import { err, ok, type Result } from './result.ts';

export const REQUIREMENTS_SECTIONS = [
  'Problem',
  'Users and scenarios',
  'Current behavior',
  'Functional requirements',
  'Non-functional requirements',
  'Out of scope',
  'Decisions',
  'Open questions',
] as const;

/** The requirements gate needs these; the other sections may say "None". */
const REQUIREMENTS_REQUIRED = ['Problem', 'Functional requirements', 'Out of scope'] as const;

export const SPEC_SECTIONS = ['Summary', 'Approach', 'Alternatives considered', 'Changes', 'Verification', 'Must not break', 'Risk'] as const;

/** One change the epic spec plans; its change spec is drafted next. */
export type PlannedChange = {
  readonly id: string;
  readonly title: string;
  readonly repo?: string;
  readonly dependsOn: readonly string[];
  readonly requirements: readonly string[];
};

export type SpecSummary = {
  readonly risk: Risk;
  readonly verification: readonly string[];
  readonly changes: readonly PlannedChange[];
};

const normalize = (heading: string): string => heading.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

/** Splits markdown into `## Heading` sections. Content before the first `##` is ignored. */
export const sections = (markdown: string): ReadonlyMap<string, string> => {
  const parts = markdown.split(/^##\s+/m).slice(1);
  return new Map(
    parts.map((part) => {
      const [heading = '', ...body] = part.split('\n');
      return [normalize(heading), body.join('\n').trim()] as const;
    }),
  );
};

export const listItems = (body: string): readonly string[] =>
  body
    .split('\n')
    .map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)$/)?.[1]?.trim())
    .filter((x): x is string => Boolean(x));

/**
 * Upper-case TODO/TBD markers and literal template placeholders. Case matters: "todo" is an ordinary
 * word (a todo app), and code like `Promise<void>` must not match either.
 */
export const PLACEHOLDER = /\b(TODO|TBD)\b|<placeholder>/;

const missingSections = (s: ReadonlyMap<string, string>, names: readonly string[]): readonly string[] =>
  names.filter((name) => !s.get(normalize(name))).map((name) => `missing or empty section "## ${name}"`);

/** Ids of list items that start with a requirement id ("- R1: ...", "- **R2** ..."), in order. */
const requirementItems = (body: string): readonly string[] =>
  listItems(body).flatMap((item) => item.match(/^\**(R\d+)\b/)?.[1] ?? []);

const duplicates = (ids: readonly string[]): readonly string[] => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

export const lintRequirements = (markdown: string): Result<{ readonly ids: readonly string[] }, readonly string[]> => {
  const s = sections(markdown);
  const functional = requirementItems(s.get('functional requirements') ?? '');
  const ids = [...functional, ...requirementItems(s.get('non functional requirements') ?? '')];
  const issues = [
    ...missingSections(s, REQUIREMENTS_REQUIRED),
    ...(s.get('functional requirements') && functional.length === 0
      ? ['"Functional requirements" needs numbered items like "- R1: ..."']
      : []),
    ...duplicates(ids).map((id) => `requirement ${id} is listed twice`),
    ...(PLACEHOLDER.test(markdown) ? ['requirements still contain TODO/TBD or <placeholder> text'] : []),
  ];
  return issues.length > 0 ? err(issues) : ok({ ids });
};

const field = (body: string, name: string): string | undefined =>
  body.match(new RegExp(`^\\s*[-*]\\s+\\**${name}\\**\\s*:\\**\\s*(.+)$`, 'im'))?.[1]?.trim();

const idsIn = (value: string | undefined, pattern: RegExp): readonly string[] =>
  value && !/^none\b/i.test(value) ? [...value.matchAll(pattern)].map((m) => m[0]) : [];

/**
 * The "## Changes" section of an epic spec: one `### C1: Title` subsection per change, with
 * "- Repo:", "- Depends on:" and "- Requirements:" lines.
 */
export const plannedChanges = (markdown: string): readonly PlannedChange[] =>
  (sections(markdown).get('changes') ?? '')
    .split(/^###\s+/m)
    .slice(1)
    .flatMap((part) => {
      const [heading = '', ...rest] = part.split('\n');
      const m = heading.trim().match(/^`?([A-Za-z0-9_-]+?)`?\s*(?:[:.—–]|\s-\s)\s*(.+)$/);
      if (!m) return [];
      const body = rest.join('\n');
      return [
        {
          id: m[1]!,
          title: m[2]!.trim(),
          repo: field(body, 'Repo')?.replace(/[`*]/g, '').trim() || undefined,
          dependsOn: idsIn(field(body, 'Depends on'), /[A-Za-z][A-Za-z0-9_-]*\d+/g),
          requirements: idsIn(field(body, 'Requirements'), /R\d+/g),
        },
      ];
    });

const planIssues = (changes: readonly PlannedChange[], requirementIds: readonly string[], repos: readonly string[]): readonly string[] => {
  const known = new Set(changes.map((c) => c.id));
  const perChange = changes.flatMap((c) => [
    ...(!c.repo
      ? [`${c.id} needs a "- Repo:" line`]
      : repos.includes(c.repo)
        ? []
        : [`${c.id}: repo "${c.repo}" is not configured (known: ${repos.join(', ')})`]),
    ...(c.requirements.length === 0 ? [`${c.id} needs a "- Requirements:" line naming the requirements it delivers`] : []),
    ...c.requirements.filter((r) => !requirementIds.includes(r)).map((r) => `${c.id} names ${r}, which is not in the requirements`),
    ...c.dependsOn.filter((d) => !known.has(d)).map((d) => `${c.id} depends on ${d}, which is not a planned change`),
  ]);
  const covered = new Set(changes.flatMap((c) => c.requirements));
  const cycle = findCycle(changes.map((c) => ({ id: c.id, dependsOn: c.dependsOn.filter((d) => known.has(d)) })));
  return [
    ...duplicates(changes.map((c) => c.id)).map((id) => `change ${id} is planned twice`),
    ...perChange,
    ...requirementIds.filter((r) => !covered.has(r)).map((r) => `${r} is not covered by any change`),
    ...(cycle.length > 0 ? [`dependency cycle among: ${cycle.join(', ')}`] : []),
  ];
};

export type SpecContext = {
  /** Ids from the approved requirements; every one must be covered by a planned change. */
  readonly requirementIds: readonly string[];
  readonly repos: readonly string[];
};

export const lintSpec = (markdown: string, ctx: SpecContext): Result<SpecSummary, readonly string[]> => {
  const s = sections(markdown);
  const verification = listItems(s.get('verification') ?? '');
  const mustNotBreak = listItems(s.get('must not break') ?? '');
  const riskWord = (s.get('risk') ?? '').split(/\s/)[0]?.toLowerCase().replace(/[^a-z]/g, '');
  const risk: Risk | undefined = riskWord === 'low' || riskWord === 'medium' || riskWord === 'high' ? riskWord : undefined;
  const changes = plannedChanges(markdown);

  const issues = [
    ...missingSections(s, SPEC_SECTIONS),
    ...(s.get('changes') && changes.length === 0 ? ['"Changes" needs at least one "### C1: Title" subsection'] : []),
    ...(changes.length > 0 ? planIssues(changes, ctx.requirementIds, ctx.repos) : []),
    ...(s.get('verification') && verification.length === 0 ? ['"Verification" needs at least one list item'] : []),
    ...(s.get('must not break') && mustNotBreak.length === 0 ? ['"Must not break" needs at least one list item'] : []),
    ...(s.get('risk') && !risk ? ['"Risk" must start with low, medium or high'] : []),
    ...(PLACEHOLDER.test(markdown) ? ['spec still contains TODO/TBD or <placeholder> text'] : []),
  ];

  return issues.length > 0 || !risk ? err(issues) : ok({ risk, verification, changes });
};
