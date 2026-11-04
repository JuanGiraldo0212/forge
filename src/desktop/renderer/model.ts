/**
 * Renderer view model: pure state, reducer and "what can I do here" rules. No React, no DOM, no IPC.
 */
import { needsHuman, stageIndex, type ChangeState, type Epic, type Stage } from '../../domain/epic.ts';
import type { ActivityLine, Outcome, WorkspaceInfo } from '../shared/api.ts';

export type Tab = 'idea' | 'exploration' | 'spec' | 'change' | 'review' | 'diff' | 'history';

export type NoteSpec = { readonly title: string; readonly label: string; readonly required: boolean; readonly confirm: string };

export type ActionId =
  | 'run'
  | 'force-run'
  | 'stop'
  | 'approve'
  | 'approve-all'
  | 'revise'
  | 'drop'
  | 'back'
  | 'abandon'
  | 'sync'
  | 'assign';

export type ActionSpec = {
  readonly id: ActionId;
  readonly label: string;
  readonly kind: 'primary' | 'secondary' | 'danger';
  /** The change it applies to; undefined = the epic (gate or whole change set). */
  readonly changeId?: string;
  /** Ask for a note before running the action. */
  readonly note?: NoteSpec;
};

export type Dialog =
  | { readonly kind: 'note'; readonly action: ActionSpec; readonly slug: string }
  | { readonly kind: 'new-epic' }
  | { readonly kind: 'back'; readonly slug: string }
  | { readonly kind: 'assign'; readonly slug: string; readonly owner: string }
  | { readonly kind: 'settings' }
  | { readonly kind: 'repos'; readonly setupRoot: string | null };

export type State = {
  readonly workspace: WorkspaceInfo | null;
  readonly recent: readonly string[];
  readonly epics: readonly Epic[];
  readonly selected: string | undefined;
  readonly changeId: string | undefined;
  /** undefined = follow whatever needs a decision. */
  readonly tab: Tab | undefined;
  readonly filter: 'all' | 'mine';
  readonly busy: readonly string[];
  readonly activity: readonly ActivityLine[];
  readonly activityOpen: boolean;
  readonly toast: (Outcome & { readonly id: number }) | undefined;
  readonly dialog: Dialog | undefined;
  /** Bumped to refetch the open document after a save. */
  readonly revision: number;
};

export const initialState: State = {
  workspace: null,
  recent: [],
  epics: [],
  selected: undefined,
  changeId: undefined,
  tab: undefined,
  filter: 'all',
  busy: [],
  activity: [],
  activityOpen: true,
  toast: undefined,
  dialog: undefined,
  revision: 0,
};

export type Action =
  | { readonly type: 'workspace'; readonly workspace: WorkspaceInfo | null; readonly recent?: readonly string[] }
  | { readonly type: 'epics'; readonly epics: readonly Epic[]; readonly select?: string }
  | { readonly type: 'select'; readonly slug: string }
  | { readonly type: 'select-change'; readonly changeId: string | undefined }
  | { readonly type: 'tab'; readonly tab: Tab | undefined }
  | { readonly type: 'filter'; readonly filter: 'all' | 'mine' }
  | { readonly type: 'busy'; readonly busy: readonly string[] }
  | { readonly type: 'activity'; readonly line: ActivityLine }
  | { readonly type: 'toggle-activity' }
  | { readonly type: 'toast'; readonly outcome: Outcome | undefined }
  | { readonly type: 'dialog'; readonly dialog: Dialog | undefined }
  | { readonly type: 'saved' };

let toastId = 0;

export const visibleEpics = (s: State): readonly Epic[] =>
  s.filter === 'mine' && s.workspace ? s.epics.filter((e) => e.owner === s.workspace!.actor) : s.epics;

export const selectedEpic = (s: State): Epic | undefined => s.epics.find((e) => e.slug === s.selected);

export const selectedChange = (s: State): ChangeState | undefined => selectedEpic(s)?.changes.find((c) => c.id === s.changeId);

/** The change most in need of a decision: drafts and reviews first, then escalations, then the first. */
export const focusChange = (e: Epic): ChangeState | undefined => {
  const order: readonly ChangeState['status'][] = ['awaiting_review', 'draft', 'escalated', 'revising', 'ready', 'running', 'mr_open', 'approved', 'merged', 'dropped'];
  return [...e.changes].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0];
};

export const reducer = (s: State, a: Action): State => {
  switch (a.type) {
    case 'workspace':
      return { ...initialState, workspace: a.workspace, recent: a.recent ?? s.recent, filter: s.filter, activityOpen: s.activityOpen };
    case 'epics': {
      const want = a.select ?? s.selected;
      const selected = a.epics.some((e) => e.slug === want) ? want : a.epics[0]?.slug;
      const epic = a.epics.find((e) => e.slug === selected);
      const keepChange = selected === s.selected && epic?.changes.some((c) => c.id === s.changeId);
      return {
        ...s,
        epics: a.epics,
        selected,
        changeId: keepChange ? s.changeId : epic && focusChange(epic)?.id,
        tab: selected === s.selected && !a.select ? s.tab : undefined,
      };
    }
    case 'select': {
      if (a.slug === s.selected) return s;
      const epic = s.epics.find((e) => e.slug === a.slug);
      return { ...s, selected: a.slug, changeId: epic && focusChange(epic)?.id, tab: undefined };
    }
    case 'select-change':
      return { ...s, changeId: a.changeId, tab: s.tab === 'idea' || s.tab === 'exploration' || s.tab === 'spec' || s.tab === 'history' ? s.tab : undefined };
    case 'tab':
      return { ...s, tab: a.tab };
    case 'filter':
      return { ...s, filter: a.filter };
    case 'busy':
      return { ...s, busy: a.busy };
    case 'activity':
      return { ...s, activity: [...s.activity, a.line].slice(-500) };
    case 'toggle-activity':
      return { ...s, activityOpen: !s.activityOpen };
    case 'toast':
      return { ...s, toast: a.outcome && { ...a.outcome, id: ++toastId } };
    case 'dialog':
      return { ...s, dialog: a.dialog };
    case 'saved':
      return { ...s, revision: s.revision + 1 };
  }
};

/** The tab to show when the user has not picked one: whatever the next decision is about. */
export const defaultTab = (e: Epic, change: ChangeState | undefined): Tab => {
  if (e.stage === 'explore') return e.revision === 0 ? 'idea' : 'exploration';
  if (e.stage === 'spec') return e.status === 'ready' && !e.pendingFeedback.length ? 'exploration' : 'spec';
  if (!change) return 'spec';
  if (change.status === 'awaiting_review' || change.status === 'escalated' || change.status === 'mr_open' || change.status === 'merged')
    return 'review';
  return 'change';
};

export const currentTab = (s: State): Tab => {
  const e = selectedEpic(s);
  return s.tab ?? (e ? defaultTab(e, selectedChange(s)) : 'idea');
};

export type StepState = 'done' | 'current' | 'gate' | 'todo';

export const stepState = (e: Epic, stage: Stage): StepState => {
  const at = stageIndex(e.stage);
  const mine = stageIndex(stage);
  if (e.stage === 'done' || mine < at) return 'done';
  if (mine > at) return 'todo';
  return stage !== 'changes' && e.status === 'awaiting_approval' ? 'gate' : 'current';
};

const note = (title: string, label: string, required: boolean, confirm: string): NoteSpec => ({ title, label, required, confirm });

/** In the change specs stage, a run drafts, redrafts, builds unblocked changes, or retries opening MRs. */
export const runWouldDoSomething = (e: Epic): boolean => {
  const merged = new Set(e.changes.filter((c) => c.status === 'merged').map((c) => c.id));
  return (
    e.changes.length === 0 ||
    e.pendingFeedback.length > 0 ||
    e.changes.some(
      (c) => c.status === 'revising' || c.status === 'approved' || (c.status === 'ready' && (c.spec?.dependsOn ?? []).every((d) => merged.has(d))),
    )
  );
};

/** Epic-level actions: the gate, the whole change set, and the epic itself. */
export const epicActions = (e: Epic, busy: boolean): readonly ActionSpec[] => {
  if (busy) return [{ id: 'stop', label: 'Stop agents', kind: 'danger' }];
  if (e.stage === 'done' || e.stage === 'abandoned') return [];
  const back: ActionSpec = { id: 'back', label: 'Send back…', kind: 'secondary' };
  const abandon: ActionSpec = { id: 'abandon', label: 'Abandon…', kind: 'danger', note: note('Abandon this epic?', 'Why', true, 'Abandon epic') };

  if (e.stage === 'explore' || e.stage === 'spec') {
    if (e.status === 'running') return [{ id: 'force-run', label: 'Restart stage', kind: 'secondary' }, abandon];
    if (e.status === 'awaiting_approval')
      return [
        { id: 'approve', label: e.stage === 'explore' ? 'Approve exploration' : 'Approve epic spec', kind: 'primary', note: note('Approve', 'Note for the next stages (optional)', false, 'Approve') },
        { id: 'revise', label: 'Request changes…', kind: 'secondary', note: note('Request changes', 'What should change', true, 'Send feedback') },
        ...(e.stage === 'spec' ? [back] : []),
        abandon,
      ];
    return [{ id: 'run', label: e.stage === 'explore' ? 'Run explore agent' : 'Write epic spec', kind: 'primary' }, ...(e.stage === 'spec' ? [back] : []), abandon];
  }

  const drafts = e.changes.filter((c) => c.status === 'draft').length;
  const runnable = runWouldDoSomething(e);
  return [
    ...(runnable ? [{ id: 'run' as const, label: e.changes.length === 0 ? 'Draft change specs' : 'Run (draft & build)', kind: 'primary' as const }] : []),
    ...(drafts > 1 ? [{ id: 'approve-all' as const, label: `Approve all ${drafts} drafts`, kind: 'secondary' as const, note: note('Approve all drafts', 'Note (optional)', false, 'Approve all') }] : []),
    ...(e.changes.length ? [{ id: 'revise' as const, label: 'Feedback on all changes…', kind: 'secondary' as const, note: note('Feedback on the change set', 'Unapproved change specs are redrafted with this', true, 'Send feedback') }] : []),
    ...(e.changes.some((c) => c.status === 'mr_open') ? [{ id: 'sync' as const, label: 'Sync MRs', kind: 'secondary' as const }] : []),
    ...(e.changes.some((c) => c.status === 'running') ? [{ id: 'force-run' as const, label: 'Recover interrupted', kind: 'secondary' as const }] : []),
    back,
    abandon,
  ];
};

/** Actions on the selected change, by its status. */
export const changeActions = (c: ChangeState, busy: boolean): readonly ActionSpec[] => {
  if (busy) return [];
  const id = c.id;
  const drop: ActionSpec = { id: 'drop', label: 'Drop…', kind: 'danger', changeId: id, note: note(`Drop ${id}?`, 'Why', true, 'Drop change') };
  switch (c.status) {
    case 'draft':
      return [
        { id: 'approve', label: 'Approve change spec', kind: 'primary', changeId: id, note: note(`Approve ${id}`, 'Note (optional)', false, 'Approve') },
        { id: 'revise', label: 'Request changes…', kind: 'secondary', changeId: id, note: note(`Redraft ${id}`, 'What should change in this change spec', true, 'Send feedback') },
        drop,
      ];
    case 'awaiting_review':
      return [
        { id: 'approve', label: 'Approve code & open MR', kind: 'primary', changeId: id, note: note(`Approve ${id}'s code`, 'Note (optional)', false, 'Approve and open MR') },
        { id: 'revise', label: 'Request rework…', kind: 'secondary', changeId: id, note: note(`Rework ${id}`, 'What should change in the code', true, 'Send feedback') },
      ];
    case 'escalated':
      return [
        { id: 'revise', label: 'Give guidance…', kind: 'primary', changeId: id, note: note(`Guidance for ${id}`, 'What should the agent do differently', true, 'Send guidance') },
        drop,
      ];
    case 'mr_open':
      return [
        { id: 'sync', label: 'Sync MR', kind: 'secondary' },
        { id: 'revise', label: 'Request rework…', kind: 'secondary', changeId: id, note: note(`Rework ${id}`, 'What should change in the code', true, 'Send feedback') },
      ];
    case 'ready':
    case 'revising':
      return [drop];
    default:
      return [];
  }
};

export const changeHint = (c: ChangeState): string => {
  switch (c.status) {
    case 'draft':
      return 'Draft. Read it, edit it if needed, then approve it or ask for a redraft.';
    case 'revising':
      return 'Feedback queued. It will be redrafted on the next run.';
    case 'ready':
      return c.spec?.dependsOn.length ? `Approved. Builds once ${c.spec.dependsOn.join(', ')} ${c.spec.dependsOn.length > 1 ? 'are' : 'is'} merged.` : 'Approved. Builds on the next run.';
    case 'running':
      return 'An agent is building this change.';
    case 'escalated':
      return `Needs your input: ${c.escalation ?? ''}`;
    case 'awaiting_review':
      return 'Built and reviewed. Check the findings and the diff, then approve the code or ask for rework.';
    case 'approved':
      return 'Code approved. The MR opens on the next run (the last attempt failed).';
    case 'mr_open':
      return 'MR open. Merge it in GitLab, then sync.';
    case 'merged':
      return 'Merged.';
    case 'dropped':
      return 'Dropped.';
  }
};

export const epicHint = (e: Epic, busy: boolean): string => {
  if (busy) return 'Agents are working. Follow along in the activity panel.';
  if (e.stage === 'done') return 'Done: every change is merged.';
  if (e.stage === 'abandoned') return 'Abandoned.';
  if (e.stage !== 'changes') {
    if (e.status === 'awaiting_approval') return `Waiting for you: read the ${e.stage === 'explore' ? 'exploration' : 'epic spec'}, edit it if needed, then approve or request changes.`;
    if (e.status === 'running') return 'Marked as running, but no agent is attached in this app. Restart the stage if it crashed.';
    return e.pendingFeedback.length ? 'Your feedback is queued. Run the agent to regenerate.' : `Next: run the ${e.stage === 'explore' ? 'explore agent' : 'epic spec agent'}.`;
  }
  if (e.changes.length === 0) return 'Next: draft change specs from the approved epic spec.';
  const waiting = e.changes.filter((c) => c.status === 'draft' || c.status === 'awaiting_review' || c.status === 'escalated');
  if (waiting.length) return `${waiting.length} change${waiting.length > 1 ? 's need' : ' needs'} you: ${waiting.map((c) => c.id).join(', ')}.`;
  return 'Nothing waiting on you. Run to draft or build what is ready, or merge open MRs.';
};

export { needsHuman };
