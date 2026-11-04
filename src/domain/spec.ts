/**
 * Epic spec lint. An epic spec cannot pass the gate unless it says what it does, how it is verified,
 * and what it must not break. Pure.
 */
import type { Risk } from './epic.ts';
import { err, ok, type Result } from './result.ts';

export const REQUIRED_SECTIONS = ['Goal', 'Non-goals', 'Behavior', 'Verification', 'Must not break', 'Risk'] as const;

export type SpecSummary = { readonly risk: Risk; readonly verification: readonly string[] };

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

export const lintSpec = (markdown: string): Result<SpecSummary, readonly string[]> => {
  const s = sections(markdown);
  const missing = REQUIRED_SECTIONS.filter((name) => !s.get(normalize(name)));
  const verification = listItems(s.get('verification') ?? '');
  const mustNotBreak = listItems(s.get('must not break') ?? '');
  const riskWord = (s.get('risk') ?? '').split(/\s/)[0]?.toLowerCase().replace(/[^a-z]/g, '');
  const risk: Risk | undefined = riskWord === 'low' || riskWord === 'medium' || riskWord === 'high' ? riskWord : undefined;

  const issues = [
    ...missing.map((name) => `missing or empty section "## ${name}"`),
    ...(s.get('verification') && verification.length === 0 ? ['"Verification" needs at least one list item'] : []),
    ...(s.get('must not break') && mustNotBreak.length === 0 ? ['"Must not break" needs at least one list item'] : []),
    ...(s.get('risk') && !risk ? ['"Risk" must start with low, medium or high'] : []),
    ...(PLACEHOLDER.test(markdown) ? ['spec still contains TODO/TBD or <placeholder> text'] : []),
  ];

  return issues.length > 0 || !risk ? err(issues) : ok({ risk, verification });
};
