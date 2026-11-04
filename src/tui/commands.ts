/**
 * TUI effects: prompts map onto the shared user actions; this file adds the TUI's own views.
 */
import { changeDiff } from '../application/build.ts';
import { changeIssues } from '../application/changes.ts';
import type { Deps } from '../application/deps.ts';
import { changeText, logText } from '../application/render.ts';
import { gateIssues } from '../application/stages.ts';
import { changeFile, STAGE_LABEL, type Epic, type GatedStage } from '../domain/epic.ts';
import {
  abandonAction,
  approveAction,
  approveAllAction,
  assignAction,
  createEpicAction,
  dropAction,
  reviseAction,
  runAction,
  sendBackAction,
  syncAction,
  type Outcome as ActionOutcome,
} from '../ui/actions.ts';
import { selectedChange, selectedEpic, type DocName, type Prompt, type Tone, type UiState, type View } from './state.ts';

export { loadAll } from '../ui/actions.ts';

export type Outcome =
  | { readonly kind: 'done'; readonly text: string; readonly tone: Tone; readonly select?: string }
  | { readonly kind: 'next'; readonly prompt: Prompt }
  | { readonly kind: 'quit' };

const done = (o: ActionOutcome): Outcome => ({ kind: 'done', text: o.text, tone: o.tone, select: o.select });

export const runSelected = async (deps: Deps, slug: string, force: boolean): Promise<Outcome> => done(await runAction(deps, slug, force));

export const syncSelected = async (deps: Deps, slug: string): Promise<Outcome> => done(await syncAction(deps, slug));

/** Handles a submitted prompt. Two-step prompts return the next prompt instead of an outcome. */
export const submitPrompt = async (deps: Deps, s: UiState, p: Prompt): Promise<Outcome> => {
  const e = selectedEpic(s);
  const note = p.value.trim();

  switch (p.kind) {
    case 'quit':
      return note.toLowerCase().startsWith('y') ? { kind: 'quit' } : { kind: 'done', text: 'Still here.', tone: 'info' };
    case 'new-title':
      return { kind: 'next', prompt: { kind: 'new-idea', label: 'Describe the epic (Enter to use the title):', value: '', required: false, context: note } };
    case 'new-idea':
      return done(await createEpicAction(deps, p.context ?? '', note));
  }

  if (!e) return { kind: 'done', text: 'No epic selected.', tone: 'error' };

  switch (p.kind) {
    case 'approve':
      return done(await approveAction(deps, e.slug, p.context, note));
    case 'approve-all':
      return done(await approveAllAction(deps, e.slug, note));
    case 'revise':
      return done(await reviseAction(deps, e.slug, p.context, note));
    case 'back-stage':
      return note === 'explore' || note === 'spec'
        ? { kind: 'next', prompt: { kind: 'back-note', label: `Why go back to ${STAGE_LABEL[note]}?`, value: '', required: true, context: note } }
        : { kind: 'done', text: `"${note}" is not explore or spec.`, tone: 'error' };
    case 'back-note':
      return done(await sendBackAction(deps, e.slug, p.context ?? '', note));
    case 'drop':
      return done(await dropAction(deps, e.slug, p.context ?? '', note));
    case 'assign':
      return done(await assignAction(deps, e.slug, note));
    case 'abandon':
      return done(await abandonAction(deps, e.slug, note));
  }
};

const HELP = `Keys

  ↑/↓ j/k   move in the focused pane          Tab      cycle focus: epics → changes → viewer
  PgUp/PgDn scroll the viewer (Space = PgDn)  Esc      back to the default view
  m         only my epics / all epics

  r         run: next stage, or draft/redraft change specs and build approved ones
  R         force-run (after a crash)
  a         approve: the open gate, or the selected change (its spec, or its code → MR)
  A         approve every draft change spec that passes its checks
  v         revise: the stage, the selected change, or the whole change set
  x         drop the selected change           b        send back to explore/spec
  e         edit the open document in $EDITOR  n        new epic
  o         change the owner                   X        abandon the epic
  s         sync MR state from GitLab

  1 idea  2 exploration  3 epic spec  4 change spec   t change review   d change diff   l log
  ?         this help                           q        quit

Flow: explore → [a] → epic spec → [a] → change specs, each: draft → [a] → build
      (agent ⇄ checks → revert test → review) → [a] → MR → merge in GitLab → s`;

const STAGE_OF: Readonly<Partial<Record<DocName, GatedStage>>> = { 'exploration.md': 'explore', 'epic-spec.md': 'spec' };

const withIssues = (content: string, issues: readonly string[]): string =>
  content + (issues.length ? `\n\n── cannot approve yet ──\n${issues.map((i) => `  ✗ ${i}`).join('\n')}` : '');

/** Text for the viewer pane. Drafts include the problems that would block approval. */
export const viewContent = async (deps: Deps, e: Epic | undefined, s: UiState, view: View): Promise<string> => {
  if (view.kind === 'help' || !e) return HELP;
  const change = selectedChange(s);
  switch (view.kind) {
    case 'doc': {
      const content = await deps.artifacts.read(e.slug, view.name);
      const stage = STAGE_OF[view.name];
      const open = stage === e.stage && e.status === 'awaiting_approval';
      return withIssues(content ?? `(${view.name} not produced yet)`, stage && open && content !== undefined ? await gateIssues(deps, e.slug, stage) : []);
    }
    case 'change-spec': {
      if (!change) return 'No change selected.';
      if (change.spec) return `(approved snapshot — edits to the file no longer apply)\n\n${change.spec.markdown}`;
      const content = (await deps.artifacts.read(e.slug, changeFile(change.id))) ?? '(no file)';
      return withIssues(content, change.status === 'draft' ? await changeIssues(deps, e, change.id) : []);
    }
    case 'change':
      return change ? changeText(change) : 'No change selected.';
    case 'diff': {
      if (!change) return 'No change selected.';
      const diff = await changeDiff(deps, e.slug, change.id);
      return diff.ok ? diff.value || '(no changes)' : diff.error.message;
    }
    case 'log':
      return logText(await deps.epics.load(e.slug));
  }
};

/** Path of the file `e` would open, if the view is editable. */
export const editablePath = (deps: Deps, s: UiState, view: View): string | undefined => {
  const e = selectedEpic(s);
  const change = selectedChange(s);
  if (!e) return undefined;
  if (view.kind === 'doc') return deps.artifacts.pathOf(e.slug, view.name);
  if (view.kind === 'change-spec' && change && !change.spec) return deps.artifacts.pathOf(e.slug, changeFile(change.id));
  return undefined;
};

export const viewTitle = (view: View, s: UiState): string => {
  const c = selectedChange(s);
  switch (view.kind) {
    case 'doc':
      return view.name;
    case 'change-spec':
      return `change spec ${c?.id ?? ''}${c?.spec ? ` [${c.spec.repo}]` : ''}`;
    case 'change':
      return `change ${c?.id ?? ''}`;
    case 'diff':
      return `diff ${c?.id ?? ''}${c?.spec ? ` [${c.spec.repo}]` : ''}`;
    case 'log':
      return 'event log';
    case 'help':
      return 'help';
  }
};
