/**
 * Markdown to HTML for agent-written documents. Agent output is untrusted: always sanitized.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

export const renderMarkdown = (md: string): string =>
  DOMPurify.sanitize(marked.parse(md, { async: false, gfm: true }) as string, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  });

const LABELS: Readonly<Record<string, string>> = { dependsOn: 'depends on' };

/** JSON-style values from the frontmatter, shown the way a person would write them. */
const pretty = (raw: string): string => {
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
    if (typeof v === 'string') return v;
  } catch {
    // Plain YAML scalar.
  }
  return raw;
};

/** Splits a change spec into its YAML frontmatter lines and its markdown body. */
export const splitFrontmatter = (md: string): { readonly header: readonly [string, string][]; readonly body: string } => {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { header: [], body: md };
  const header = (m[1] ?? '')
    .split('\n')
    .map((line) => line.match(/^([A-Za-z]+):\s*(.*)$/))
    .filter((x): x is RegExpMatchArray => Boolean(x))
    .map((x) => [LABELS[x[1]!] ?? x[1]!, pretty(x[2]!)] as [string, string]);
  return { header, body: md.slice(m[0].length) };
};
