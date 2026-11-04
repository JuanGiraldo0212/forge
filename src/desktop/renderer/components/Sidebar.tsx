import { STAGE_LABEL } from '../../../domain/epic.ts';
import type { WorkspaceInfo } from '../../shared/api.ts';
import { needsHuman, visibleEpics, type State } from '../model.ts';
import { Avatar, Button, Chip, Spinner } from './ui.tsx';

export const Sidebar = ({
  state,
  workspace,
  onSelect,
  onFilter,
  onNew,
  onSwitch,
  onSettings,
  onRepos,
}: {
  state: State;
  workspace: WorkspaceInfo;
  onSelect: (slug: string) => void;
  onFilter: (f: 'all' | 'mine') => void;
  onNew: () => void;
  onSwitch: () => void;
  onSettings: () => void;
  onRepos: () => void;
}) => {
  const epics = visibleEpics(state);
  const mineWaiting = state.epics.filter((e) => e.owner === workspace.actor && needsHuman(e)).length;
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo">forge</span>
        <button className="workspace-switch" onClick={onSwitch} title={workspace.root}>
          {workspace.name} ▾
        </button>
      </div>
      <div className="repos">
        {workspace.repos.map((r) => (
          <Chip key={r.name} tone={r.present ? 'neutral' : 'bad'} title={r.present ? `${r.root}\nGitLab ${r.project}` : `Missing clone at ${r.root}`}>
            {r.present ? '' : '⚠ '}
            {r.name}
          </Chip>
        ))}
        <button className="chip chip-button" onClick={onRepos} title="Add or edit repositories">
          {workspace.repos.length ? 'Edit' : '+ Add repo'}
        </button>
      </div>
      <div className="sidebar-tools">
        <div className="segmented" role="tablist">
          <button className={state.filter === 'all' ? 'on' : ''} onClick={() => onFilter('all')}>
            All
          </button>
          <button className={state.filter === 'mine' ? 'on' : ''} onClick={() => onFilter('mine')}>
            Mine{mineWaiting ? <span className="badge">{mineWaiting}</span> : null}
          </button>
        </div>
        <Button kind="primary" onClick={onNew}>
          New epic
        </Button>
      </div>
      <nav className="epic-list">
        {epics.length === 0 && <p className="empty">{state.filter === 'mine' ? 'No epics of yours yet.' : 'No epics yet. Create one to start.'}</p>}
        {epics.map((e) => {
          const busy = state.busy.includes(e.slug);
          const waiting = needsHuman(e);
          return (
            <button key={e.slug} className={`epic-item${e.slug === state.selected ? ' selected' : ''}`} onClick={() => onSelect(e.slug)}>
              <span className="epic-marker">{busy ? <Spinner /> : waiting ? <span className="dot dot-warn" title="Needs a decision" /> : e.stage === 'done' ? <span className="dot dot-good" /> : <span className="dot dot-muted" />}</span>
              <span className="epic-text">
                <span className="epic-title">{e.title}</span>
                <span className="epic-meta">
                  {STAGE_LABEL[e.stage]}
                  {e.changes.length ? ` · ${e.changes.filter((c) => c.status === 'merged').length}/${e.changes.filter((c) => c.status !== 'dropped').length} merged` : ''}
                </span>
              </span>
              <Avatar email={e.owner} mine={e.owner === workspace.actor} />
            </button>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <span className="who" title="Who forge records as the actor (git config user.email)">
          {workspace.actor}
        </span>
        <button className="icon-btn" onClick={onSettings} title="Settings">
          ⚙
        </button>
      </div>
    </aside>
  );
};
