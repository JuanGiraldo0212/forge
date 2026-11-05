/**
 * The selected epic: header with stage stepper (which also picks the stage shown) and epic-level actions,
 * the change list, and the selected change's status bar.
 */
import { STAGE_LABEL, type ChangeState, type DocStage, type Epic, type Stage } from '../../../domain/epic.ts';
import { canView, changeActions, changeHint, epicActions, epicHint, needsHuman, stepState, type ActionSpec } from '../model.ts';
import { ActionButtons, Avatar, Chip, Spinner, StatusPill } from './ui.tsx';

const STEPS = ['requirements', 'spec', 'changes', 'development'] as const;

/** The stages, as tabs: a click shows that stage's documents. Stages not reached yet can't be opened. */
export const Stepper = ({ epic, busy, view, onView }: { epic: Epic; busy: boolean; view: DocStage; onView: (stage: DocStage) => void }) => (
  <ol className="stepper">
    {STEPS.map((stage) => {
      const state = stepState(epic, stage);
      return (
        <li key={stage} className={`step step-${state}${stage === view ? ' step-viewing' : ''}`}>
          <button className="step-button" disabled={!canView(epic, stage)} aria-current={stage === view ? 'page' : undefined} onClick={() => onView(stage)}>
            <span className="step-icon">{state === 'current' && busy ? <Spinner /> : state === 'done' ? '✓' : state === 'gate' ? '◆' : state === 'current' ? '●' : '○'}</span>
            {STAGE_LABEL[stage]}
            {state === 'gate' && <span className="step-note">{epic.status === 'awaiting_answers' ? 'your answers' : 'your review'}</span>}
          </button>
        </li>
      );
    })}
  </ol>
);

export const EpicHeader = ({
  epic,
  busy,
  actor,
  view,
  onView,
  onAction,
  onAssign,
}: {
  epic: Epic;
  busy: boolean;
  actor: string;
  view: DocStage;
  onView: (stage: DocStage) => void;
  onAction: (a: ActionSpec) => void;
  onAssign: () => void;
}) => (
  <header className="epic-header">
    <div className="epic-heading">
      <h1>{epic.title}</h1>
      <div className="epic-facts">
        <button className="owner" onClick={onAssign} title="Change owner">
          <Avatar email={epic.owner} mine={epic.owner === actor} /> {epic.owner}
        </button>
        <span className="muted">{epic.slug}</span>
        <span className="muted" title="Agent SDK estimate, not a bill">
          ~${epic.costUsd.toFixed(2)}
        </span>
      </div>
    </div>
    <Stepper epic={epic} busy={busy} view={view} onView={onView} />
    <div className={`hint${needsHuman(epic) && !busy ? ' hint-warn' : ''}`}>
      <span>{epicHint(epic, busy)}</span>
      <ActionButtons actions={epicActions(epic, busy)} onAction={onAction} />
    </div>
    {epic.lastError && <div className="banner banner-bad">Last error: {epic.lastError}</div>}
    {epic.pendingFeedback.length > 0 && (
      <div className="banner banner-info">
        Queued feedback:
        <ul>
          {epic.pendingFeedback.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      </div>
    )}
  </header>
);

export const ChangeList = ({ epic, selected, onSelect }: { epic: Epic; selected: string | undefined; onSelect: (id: string) => void }) => (
  <section className="change-list" aria-label="Change specs">
    <h2>
      Changes <span className="muted">{epic.changes.filter((c) => c.status !== 'dropped').length}</span>
    </h2>
    {epic.changes.map((c) => (
      <button key={c.id} className={`change-item${c.id === selected ? ' selected' : ''}${c.status === 'dropped' ? ' dropped' : ''}`} onClick={() => onSelect(c.id)}>
        <span className="change-top">
          <span className="change-id">{c.id}</span>
          {c.spec && <Chip>{c.spec.repo}</Chip>}
          <StatusPill status={c.status} />
        </span>
        <span className="change-title">{c.title}</span>
        {c.spec?.dependsOn.length ? <span className="change-deps">after {c.spec.dependsOn.join(', ')}</span> : null}
      </button>
    ))}
  </section>
);

/** `readOnly`: an earlier stage being looked back at; its decisions are made, so it offers no actions. */
export const ChangeBar = ({
  change,
  stage,
  readOnly,
  busy,
  onAction,
  onOpenUrl,
}: {
  change: ChangeState;
  stage: Stage;
  readOnly: boolean;
  busy: boolean;
  onAction: (a: ActionSpec) => void;
  onOpenUrl: (url: string) => void;
}) => (
  <div className={`change-bar change-bar-${change.status}`}>
    <div className="change-bar-text">
      <strong>{change.id}</strong>
      {change.spec && <Chip>{change.spec.repo}</Chip>}
      <StatusPill status={change.status} />
      <span>{changeHint(change, stage)}</span>
      {change.mergeRequest && (
        <a
          href={change.mergeRequest.url}
          onClick={(e) => {
            e.preventDefault();
            onOpenUrl(change.mergeRequest!.url);
          }}
        >
          MR !{change.mergeRequest.iid} ↗
        </a>
      )}
    </div>
    {!readOnly && <ActionButtons actions={changeActions(change, busy)} onAction={onAction} />}
  </div>
);
