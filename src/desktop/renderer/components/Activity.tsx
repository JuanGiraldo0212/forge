import { useEffect, useRef } from 'react';
import type { ActivityLine } from '../../shared/api.ts';
import { Button, Spinner } from './ui.tsx';

const COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];
const colorOf = (label: string) => COLORS[[...label].reduce((h, c) => h + c.charCodeAt(0), 0) % COLORS.length];

export const Activity = ({
  lines,
  open,
  busy,
  selected,
  onToggle,
  onStop,
}: {
  lines: readonly ActivityLine[];
  open: boolean;
  busy: readonly string[];
  selected: string | undefined;
  onToggle: () => void;
  onStop: (slug: string) => void;
}) => {
  const end = useRef<HTMLDivElement>(null);
  const shown = selected ? lines.filter((l) => l.epic === selected || l.epic === '') : lines;
  // Braces matter: newer Chromium returns a Promise from scrollIntoView, and React would call it as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [shown.length, open]);
  return (
    <section className={`activity${open ? ' open' : ''}`} aria-label="Agent activity">
      <header>
        <button className="activity-toggle" onClick={onToggle} aria-expanded={open}>
          {open ? '▾' : '▸'} Activity
        </button>
        {busy.length > 0 && (
          <span className="activity-busy">
            <Spinner /> {busy.join(', ')}
          </span>
        )}
        <span className="spacer" />
        {busy.map((slug) => (
          <Button key={slug} kind="danger" onClick={() => onStop(slug)}>
            Stop {slug}
          </Button>
        ))}
      </header>
      {open && (
        <div className="activity-lines">
          {shown.length === 0 && <p className="muted">Agent tool calls appear here while agents work.</p>}
          {shown.slice(-300).map((l, i) => (
            <div key={i} className="activity-line">
              <time>{new Date(l.at).toLocaleTimeString()}</time>
              <span className="activity-label" style={{ color: colorOf(l.label) }}>
                {l.label}
              </span>
              <span>{l.text}</span>
            </div>
          ))}
          <div ref={end} />
        </div>
      )}
    </section>
  );
};
