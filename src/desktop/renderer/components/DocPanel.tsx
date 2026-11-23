/**
 * Document viewer and editor: idea, requirements, epic spec, change spec, review, diff, history.
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { stageDialog, type ChangeState, type DocStage, type Epic, type Finding, type FindingStatus } from '../../../domain/epic.ts';
import type { DocName, DocView, HistoryEntry, Outcome } from '../../shared/api.ts';
import { renderMarkdown, splitFrontmatter } from '../markdown.ts';
import type { Tab } from '../model.ts';
import { QuestionsPanel } from './QuestionsPanel.tsx';
import { Button, Chip } from './ui.tsx';

const DOC_OF: Partial<Record<Tab, DocName>> = { idea: 'idea.md', requirements: 'requirements.md', spec: 'epic-spec.md' };

const TAB_LABEL: Record<Tab, string> = {
  idea: 'Idea',
  questions: 'Questions',
  requirements: 'Requirements',
  spec: 'Epic spec',
  change: 'Change spec',
  review: 'Review',
  diff: 'Diff',
  history: 'History',
};

/** Clicks on links in rendered markdown open in the browser, never in the app. */
const interceptLinks = (onOpenUrl: (url: string) => void) => (e: MouseEvent<HTMLElement>) => {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(a.href)) onOpenUrl(a.href);
};

export const Markdown = ({ md, onOpenUrl }: { md: string; onOpenUrl: (url: string) => void }) => (
  <article className="markdown" onClick={interceptLinks(onOpenUrl)} dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }} />
);

const ChangeSpecView = ({ md, onOpenUrl }: { md: string; onOpenUrl: (url: string) => void }) => {
  const { header, body } = splitFrontmatter(md);
  return (
    <>
      {header.length > 0 && (
        <dl className="frontmatter">
          {header.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <Markdown md={body} onOpenUrl={onOpenUrl} />
    </>
  );
};

const Issues = ({ issues }: { issues: readonly string[] }) =>
  issues.length ? (
    <div className="banner banner-bad">
      <strong>Can't be approved yet</strong>
      <ul>
        {issues.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  ) : null;

const FINDING_STATUS: Readonly<Record<FindingStatus, { readonly label: string; readonly tone: 'good' | 'bad' | 'warn' | undefined }>> = {
  open: { label: 'open', tone: undefined },
  fixed: { label: 'fixed', tone: 'good' },
  disputed: { label: 'disputed', tone: 'warn' },
  needs_input: { label: 'needs your decision', tone: 'bad' },
  invalid: { label: 'dismissed', tone: undefined },
};

/** One review finding: where it stands, the latest word on it, and the owner's dismiss/reopen. */
const FindingRow = ({ f, onSet, busy }: { f: Finding; onSet?: (id: string, action: 'dismiss' | 'reopen') => void; busy: boolean }) => {
  const status = f.status ?? 'open';
  const settled = status === 'fixed' || status === 'invalid';
  const action = status === 'invalid' ? 'reopen' : status === 'fixed' ? undefined : 'dismiss';
  return (
    <li className={`finding finding-${f.severity}${settled ? ' finding-settled' : ''}`}>
      {f.id && <code>{f.id}</code>}
      <Chip tone={f.severity === 'blocking' ? 'bad' : 'warn'}>{f.severity}</Chip>
      {status !== 'open' && <Chip tone={FINDING_STATUS[status].tone}>{FINDING_STATUS[status].label}</Chip>}
      {f.file && (
        <code>
          {f.file}
          {f.line ? `:${f.line}` : ''}
        </code>
      )}
      <span>{f.summary}</span>
      {f.id && onSet && action && (
        <Button
          kind="ghost"
          disabled={busy}
          title={action === 'dismiss' ? 'Not a real problem: the reviewer will not raise it again' : 'Raise it again'}
          onClick={() => onSet(f.id!, action)}
        >
          {action === 'dismiss' ? 'Dismiss' : 'Reopen'}
        </Button>
      )}
      {f.detail && <p className="muted">{f.detail}</p>}
      {f.note && <p className="finding-note">{f.note}</p>}
    </li>
  );
};

const Review = ({
  change,
  onOpenUrl,
  onSetFinding,
  busy,
}: {
  change: ChangeState;
  onOpenUrl: (url: string) => void;
  onSetFinding?: (id: string, action: 'dismiss' | 'reopen') => void;
  busy: boolean;
}) => (
  <div className="review">
    <dl className="facts">
      <div>
        <dt>Status</dt>
        <dd>{change.status}</dd>
      </div>
      {change.branch && (
        <div>
          <dt>Branch</dt>
          <dd>
            <code>{change.branch}</code>
          </dd>
        </div>
      )}
      {change.commit && (
        <div>
          <dt>Commit</dt>
          <dd>
            <code>{change.commit.slice(0, 10)}</code>
          </dd>
        </div>
      )}
      <div>
        <dt>Revert test</dt>
        <dd>{change.revertTest === 'passed' ? 'passed: tests fail without the change' : change.revertTest === 'skipped' ? 'not required for this kind' : '—'}</dd>
      </div>
      <div>
        <dt>Rounds this attempt</dt>
        <dd>{change.failures.length}</dd>
      </div>
      {change.mergeRequest && (
        <div>
          <dt>Merge request</dt>
          <dd>
            <a
              href={change.mergeRequest.url}
              onClick={(e) => {
                e.preventDefault();
                onOpenUrl(change.mergeRequest!.url);
              }}
            >
              !{change.mergeRequest.iid} ↗
            </a>
          </dd>
        </div>
      )}
    </dl>
    {change.escalation && <div className="banner banner-bad">Escalated: {change.escalation}</div>}
    {change.foreignHead && change.status === 'mr_open' && change.foreignHead !== change.commit && (
      <div className="banner banner-info">
        The MR has commits forge did not push ({change.foreignHead.slice(0, 8)}). Forge stopped fixing it on its own; ask for rework here to continue.
      </div>
    )}
    <h3>Findings</h3>
    {change.findings.length === 0 ? (
      <p className="muted">{change.branch ? 'No findings.' : 'Not reviewed yet.'}</p>
    ) : (
      <ul className="findings">
        {change.findings.map((f, i) => (
          <FindingRow key={f.id ?? i} f={f} onSet={change.status === 'running' ? undefined : onSetFinding} busy={busy} />
        ))}
      </ul>
    )}
    {change.mergeRequestFeedback && (
      <>
        <h3>{change.status === 'escalated' && !change.mergeRequestFeedback.responses ? 'MR feedback waiting for you' : 'MR feedback in progress'}</h3>
        <ul>
          {change.mergeRequestFeedback.items.map((item) => {
            const r = change.mergeRequestFeedback?.responses?.find((x) => x.id === item.id);
            return (
              <li key={item.id}>
                <Chip>{item.kind === 'ci' ? 'pipeline' : 'thread'}</Chip>{' '}
                {item.kind === 'ci'
                  ? `#${item.pipelineId} failed: ${item.jobs.map((j) => j.name).join(', ')}`
                  : `${item.thread.at(-1)?.author ?? ''}: ${item.thread.at(-1)?.body.slice(0, 200) ?? ''}`}
                {r && <p className="finding-note">{r.outcome.replace('_', ' ')}: {r.reply}</p>}
              </li>
            );
          })}
        </ul>
      </>
    )}
    {(change.specFeedback.length > 0 || change.feedback.length > 0) && (
      <>
        <h3>Your feedback</h3>
        <ul>
          {change.specFeedback.map((f, i) => (
            <li key={`s${i}`}>
              <Chip>spec</Chip> {f}
            </li>
          ))}
          {change.feedback.map((f, i) => (
            <li key={`c${i}`}>
              <Chip>code</Chip> {f}
            </li>
          ))}
        </ul>
      </>
    )}
  </div>
);

const Diff = ({ text }: { text: string }) => (
  <pre className="diff">
    {text.split('\n').map((line, i) => {
      const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
      return (
        <span key={i} className={`diff-line ${cls}`}>
          {line || ' '}
          {'\n'}
        </span>
      );
    })}
  </pre>
);

const History = ({ entries }: { entries: readonly HistoryEntry[] }) => (
  <ol className="history">
    {[...entries].reverse().map((e, i) => (
      <li key={i}>
        <time>{new Date(e.at).toLocaleString()}</time>
        <span className={e.by === 'forge' ? 'by-forge' : 'by-human'}>{e.by}</span>
        <span>{e.text}</span>
      </li>
    ))}
  </ol>
);

type Loaded =
  | { readonly kind: 'doc'; readonly view: DocView }
  | { readonly kind: 'diff'; readonly text: string }
  | { readonly kind: 'history'; readonly entries: readonly HistoryEntry[] }
  | { readonly kind: 'review' };

export const DocPanel = ({
  epic,
  view,
  change,
  tabs,
  tab,
  revision,
  onTab,
  onSaved,
  onOpenUrl,
  busy,
}: {
  epic: Epic;
  view: DocStage;
  change: ChangeState | undefined;
  tabs: readonly Tab[];
  tab: Tab;
  revision: number;
  onTab: (t: Tab) => void;
  onSaved: (o: Outcome) => void;
  onOpenUrl: (url: string) => void;
  busy: boolean;
}) => {
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded } | undefined>();
  const [draft, setDraft] = useState<string | undefined>();
  const key = JSON.stringify([epic.slug, change?.id, tab, epic.updatedAt, revision]);

  useEffect(() => {
    let live = true;
    setDraft(undefined);
    const doc = DOC_OF[tab];
    const load = async (): Promise<Loaded> => {
      if (doc) return { kind: 'doc', view: await window.forge.readDoc(epic.slug, doc) };
      if (tab === 'change' && change) return { kind: 'doc', view: await window.forge.readChangeSpec(epic.slug, change.id) };
      if (tab === 'diff' && change) return { kind: 'diff', text: await window.forge.diff(epic.slug, change.id) };
      if (tab === 'history') return { kind: 'history', entries: await window.forge.history(epic.slug) };
      return { kind: 'review' };
    };
    void load().then((value) => live && setLoaded({ key, value }));
    return () => {
      live = false;
    };
  }, [key]);

  const current = loaded?.key === key ? loaded.value : undefined;

  const save = async () => {
    if (draft === undefined || current?.kind !== 'doc') return;
    const doc = DOC_OF[tab];
    const outcome = doc ? await window.forge.writeDoc(epic.slug, doc, draft) : await window.forge.writeChangeSpec(epic.slug, change!.id, draft);
    onSaved(outcome);
    if (outcome.ok) setDraft(undefined);
  };

  return (
    <section className="doc-panel">
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={t === tab} className={t === tab ? 'on' : ''} onClick={() => onTab(t)}>
            {t === 'change' || t === 'review' || t === 'diff' ? `${TAB_LABEL[t]} ${change?.id ?? ''}` : TAB_LABEL[t]}
            {t === 'questions' && epic.status === 'awaiting_answers' ? <span className="badge">{epic.dialog?.questions.filter((q) => !q.answer).length}</span> : null}
          </button>
        ))}
        {current?.kind === 'doc' && current.view.editable && draft === undefined && (
          <span className="tab-tools">
            <Button kind="ghost" onClick={() => setDraft(current.view.content ?? '')}>
              Edit
            </Button>
          </span>
        )}
        {draft !== undefined && (
          <span className="tab-tools">
            <Button kind="ghost" onClick={() => setDraft(undefined)}>
              Cancel
            </Button>
            <Button kind="primary" onClick={save}>
              Save
            </Button>
          </span>
        )}
      </div>
      <div className="doc-body">
        {!current && <p className="muted">Loading…</p>}
        {current?.kind === 'doc' && (
          <>
            {current.view.snapshot && <div className="banner banner-info">Approved snapshot. This is exactly what gets built; later edits to the file don't apply.</div>}
            <Issues issues={current.view.issues} />
            {draft !== undefined ? (
              <textarea className="editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck autoFocus aria-label="Edit document" />
            ) : current.view.content === undefined ? (
              <p className="muted">Not written yet.</p>
            ) : tab === 'change' ? (
              <ChangeSpecView md={current.view.content} onOpenUrl={onOpenUrl} />
            ) : (
              <Markdown md={current.view.content} onOpenUrl={onOpenUrl} />
            )}
          </>
        )}
        {tab === 'questions' && <QuestionsPanel key={`${epic.slug}:${view}`} epic={epic} dialog={view === 'requirements' || view === 'spec' ? stageDialog(epic, view) : undefined} busy={busy} onAnswered={onSaved} />}
        {current?.kind === 'review' && tab !== 'questions' && change && (
          <Review
            change={change}
            onOpenUrl={onOpenUrl}
            busy={busy}
            onSetFinding={async (id, action) => onSaved(await window.forge.finding(epic.slug, change.id, id, action, ''))}
          />
        )}
        {current?.kind === 'diff' && <Diff text={current.text} />}
        {current?.kind === 'history' && <History entries={current.entries} />}
      </div>
    </section>
  );
};
