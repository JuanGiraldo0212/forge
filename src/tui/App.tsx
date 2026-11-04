/**
 * Full-screen TUI. Pure rendering of UiState plus the effects that call use cases.
 */
import { spawnSync } from 'node:child_process';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Deps } from '../application/deps.ts';
import { stageIndex, STAGE_LABEL, type ChangeState, type Epic } from '../domain/epic.ts';
import { editablePath, loadAll, runSelected, submitPrompt, syncSelected, viewContent, viewTitle, type Outcome } from './commands.ts';
import {
  currentView,
  initialState,
  isBusy,
  keyToIntent,
  needsHuman,
  reducer,
  selectedChange,
  selectedEpic,
  visibleEpics,
  type ActivityLine,
  type Command,
  type UiState,
} from './state.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const Spinner = () => {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 100);
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">{SPINNER[frame]}</Text>;
};

const shortOwner = (owner: string): string => owner.split('@')[0]!.slice(0, 10);

const epicMarker = (e: Epic, busy: boolean) => {
  if (busy) return <Spinner />;
  if (e.stage === 'done') return <Text color="green">✓</Text>;
  if (e.stage === 'abandoned') return <Text dimColor>×</Text>;
  if (needsHuman(e)) return <Text color="yellow">●</Text>;
  return <Text dimColor>·</Text>;
};

const EpicList = ({ s, height, width }: { s: UiState; height: number; width: number }) => {
  const epics = visibleEpics(s);
  const visible = Math.max(1, height - 3);
  const start = Math.max(0, Math.min(s.selected - Math.floor(visible / 2), epics.length - visible));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={s.focus === 'epics' ? 'cyan' : 'gray'} width={width} height={height} paddingX={1} flexShrink={0}>
      <Box justifyContent="space-between">
        <Text bold>Epics</Text>
        <Text dimColor>{s.mineOnly ? 'mine (m)' : 'all (m)'}</Text>
      </Box>
      {epics.length === 0 && <Text dimColor>{s.mineOnly ? 'none of yours — m for all' : 'none yet — press n'}</Text>}
      {epics.slice(start, start + visible).map((e, i) => {
        const selected = start + i === s.selected;
        return (
          <Box key={e.slug}>
            <Box width={2} flexShrink={0}>
              {epicMarker(e, isBusy(s, e.slug))}
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text inverse={selected && s.focus === 'epics'} bold={selected} wrap="truncate-end">
                {e.slug}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor color={e.owner === s.actor ? 'cyan' : undefined}>
                {' '}
                {shortOwner(e.owner)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};

const STAGES = ['explore', 'spec', 'changes'] as const;

const Rail = ({ e, busy }: { e: Epic; busy: boolean }) => (
  <Box>
    {STAGES.map((stage, i) => {
      const at = stageIndex(e.stage);
      const mine = stageIndex(stage);
      const current = at === mine;
      const past = mine < at || e.stage === 'done';
      const gate = current && stage !== 'changes' && e.status === 'awaiting_approval';
      const icon = past ? '✓' : current ? (gate ? '◆' : '●') : '○';
      const color = past ? 'green' : current ? (gate ? 'yellow' : 'cyan') : 'gray';
      return (
        <Box key={stage}>
          {i > 0 && <Text dimColor> ── </Text>}
          {current && busy ? <Spinner /> : <Text color={color}>{icon}</Text>}
          <Text color={current ? color : undefined} bold={current}>
            {' '}
            {STAGE_LABEL[stage]}
          </Text>
        </Box>
      );
    })}
  </Box>
);

const CHANGE_COLOR: Record<ChangeState['status'], string> = {
  draft: 'yellow',
  revising: 'magenta',
  ready: 'white',
  running: 'cyan',
  escalated: 'red',
  awaiting_review: 'yellow',
  approved: 'green',
  mr_open: 'blue',
  merged: 'green',
  dropped: 'gray',
};

const hint = (e: Epic, change: ChangeState | undefined, busy: boolean): string => {
  if (busy) return 'Agent working… activity below.';
  if (e.stage === 'done') return 'Done: every change is merged.';
  if (e.stage === 'abandoned') return 'Abandoned.';
  if (e.stage !== 'changes') {
    if (e.status === 'awaiting_approval') return `Gate open: read the ${STAGE_LABEL[e.stage]}, then a approve · v revise · e edit · b back`;
    if (e.status === 'running') return 'Marked running but no agent is attached here. R to force-restart.';
    return `${e.pendingFeedback.length ? 'Feedback queued. ' : ''}r to run the ${STAGE_LABEL[e.stage]} agent.`;
  }
  if (e.changes.length === 0 || e.pendingFeedback.length) return 'r to draft the change specs from the epic spec.';
  switch (change?.status) {
    case 'draft':
      return `${change.id} is a draft: 4 read · e edit · a approve · v redraft · x drop · A approve all drafts`;
    case 'revising':
      return `${change.id} will be redrafted on the next run (r).`;
    case 'awaiting_review':
      return `${change.id} code needs review: t findings · d diff · a approve (opens MR) · v rework`;
    case 'escalated':
      return `${change.id} escalated: ${change.escalation ?? ''} — v to give guidance, x to drop`;
    case 'mr_open':
      return `${change.id} MR open: merge it in GitLab, then s to sync.`;
  }
  return 'Tab to the changes, ↑/↓ to pick one. r builds approved changes.';
};

const Detail = ({ s, e }: { s: UiState; e: Epic }) => {
  const busy = isBusy(s, e.slug);
  const change = selectedChange(s);
  const maxRows = 7;
  const start = Math.max(0, Math.min(s.changeIndex - 3, e.changes.length - maxRows));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={s.focus === 'changes' ? 'cyan' : 'gray'} paddingX={1} flexShrink={0}>
      <Box justifyContent="space-between">
        <Text bold wrap="truncate-end">
          {e.title}
        </Text>
        <Text dimColor>
          {e.owner} · rev {e.revision} · ~${e.costUsd.toFixed(2)}
        </Text>
      </Box>
      <Rail e={e} busy={busy} />
      <Text color={busy ? 'cyan' : needsHuman(e) ? 'yellow' : undefined} wrap="truncate-end">
        {hint(e, change, busy)}
      </Text>
      {e.lastError && (
        <Text color="red" wrap="truncate-end">
          last error: {e.lastError}
        </Text>
      )}
      {e.changes.slice(start, start + maxRows).map((c, i) => {
        const selected = start + i === s.changeIndex;
        return (
          <Text key={c.id} wrap="truncate-end" inverse={selected && s.focus === 'changes'}>
            {selected ? '›' : ' '} <Text color={CHANGE_COLOR[c.status]}>{c.status.padEnd(15)}</Text> {c.id.padEnd(4)}{' '}
            <Text dimColor>{c.spec ? `[${c.spec.repo}] ` : ''}</Text>
            {c.title}
            {c.spec?.dependsOn.length ? <Text dimColor> (after {c.spec.dependsOn.join(', ')})</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
};

const lineColor = (line: string): { color?: string; bold?: boolean; dimColor?: boolean } => {
  if (line.startsWith('+++') || line.startsWith('---')) return { bold: true };
  if (line.startsWith('+')) return { color: 'green' };
  if (line.startsWith('-') && !line.startsWith('- ')) return { color: 'red' };
  if (line.startsWith('@@')) return { color: 'cyan' };
  if (/^#{1,3} /.test(line)) return { color: 'cyan', bold: true };
  if (line.includes('✗') || /\[blocking\]/.test(line)) return { color: 'red' };
  if (/\[advisory\]/.test(line)) return { color: 'yellow' };
  if (line.startsWith('──') || line.startsWith('(approved snapshot')) return { dimColor: true };
  return {};
};

const Viewer = ({ title, lines, scroll, height, focused }: { title: string; lines: readonly string[]; scroll: number; height: number; focused: boolean }) => {
  const inner = Math.max(1, height - 3);
  const top = Math.min(scroll, Math.max(0, lines.length - inner));
  const shown = lines.slice(top, top + inner);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} height={height} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text bold>{title}</Text>
        <Text dimColor>{lines.length > inner ? `${top + 1}–${top + shown.length} / ${lines.length}` : ''}</Text>
      </Box>
      {shown.map((line, i) => (
        <Text key={top + i} wrap="truncate-end" {...lineColor(line)}>
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
};

const LABEL_COLORS = ['magenta', 'blue', 'green', 'yellow', 'cyan'];
const labelColor = (label: string) => LABEL_COLORS[[...label].reduce((h, c) => h + c.charCodeAt(0), 0) % LABEL_COLORS.length];

const Activity = ({ lines }: { lines: readonly ActivityLine[] }) => (
  <Box flexDirection="column" height={3} paddingX={1}>
    {lines.length === 0 && <Text dimColor>agent activity appears here</Text>}
    {lines.slice(-3).map((l, i) => (
      <Text key={i} wrap="truncate-end">
        <Text color={labelColor(l.label)}>[{l.label}]</Text> <Text dimColor>{l.text}</Text>
      </Text>
    ))}
  </Box>
);

const KEYS = 'r run  a approve  A approve drafts  v revise  x drop  e edit  n new  m mine  1-4 docs  t review  d diff  l log  ? help  q quit';

const Footer = ({ s }: { s: UiState }) => (
  <Box flexDirection="column" paddingX={1}>
    {s.prompt ? (
      <Text>
        <Text color="cyan" bold>
          {s.prompt.label}{' '}
        </Text>
        {s.prompt.value}
        <Text inverse> </Text>
        <Text dimColor>  Enter submit · Esc cancel</Text>
      </Text>
    ) : (
      <Text color={s.message?.tone === 'error' ? 'red' : s.message?.tone === 'success' ? 'green' : undefined} wrap="truncate-end">
        {s.message ? `${s.message.tone === 'error' ? '✗' : s.message.tone === 'success' ? '✓' : '·'} ${s.message.text}` : ' '}
      </Text>
    )}
    <Text dimColor wrap="truncate-end">
      {KEYS}
    </Text>
  </Box>
);

export type AppProps = {
  readonly deps: Deps;
  readonly workspaceName: string;
  readonly subscribe: (fn: (line: ActivityLine) => void) => () => void;
  readonly warnings?: readonly string[];
  /** Overridable for tests. */
  readonly pollMs?: number;
};

export const App = ({ deps, workspaceName, subscribe, warnings = [], pollMs = 2000 }: AppProps) => {
  const [s, dispatch] = useReducer(reducer, deps.actor, initialState);
  const ref = useRef(s);
  ref.current = s;
  const { exit, suspendTerminal } = useApp();
  const size = useWindowSize();
  const rows = size.rows || 30;
  const columns = size.columns || 100;
  // Content is tagged with the view it was fetched for, so a stale fetch never shows under a new title.
  const [content, setContent] = useState<{ readonly key: string; readonly text: string }>({ key: '', text: '' });
  const [refresh, setRefresh] = useState(0);

  const reload = useCallback(async (select?: string) => dispatch({ type: 'loaded', epics: await loadAll(deps), select }), [deps]);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), pollMs);
    return () => clearInterval(id);
  }, [reload, pollMs]);

  useEffect(() => subscribe((line) => dispatch({ type: 'activity', line })), [subscribe]);
  useEffect(() => {
    if (warnings.length) dispatch({ type: 'message', text: warnings.join(' · '), tone: 'error' });
  }, [warnings]);

  const e = selectedEpic(s);
  const change = selectedChange(s);
  const view = currentView(s);
  const viewKey = JSON.stringify([e?.slug, change?.id, view]);
  useEffect(() => {
    let live = true;
    void viewContent(deps, e, ref.current, view).then((text) => live && setContent({ key: viewKey, text }));
    return () => {
      live = false;
    };
    // Refetch when the epic changes on disk, the selection moves, or the view changes.
  }, [deps, e?.slug, e?.updatedAt, change?.id, viewKey, refresh]);

  // Reload before showing the outcome, so the message and the state it describes appear together.
  const report = useCallback(
    async (o: Outcome) => {
      if (o.kind === 'quit') return exit();
      if (o.kind === 'next') return dispatch({ type: 'prompt', prompt: o.prompt });
      await reload(o.select);
      dispatch({ type: 'message', text: o.text, tone: o.tone });
    },
    [exit, reload],
  );

  const withBusy = useCallback(
    async (slug: string, work: () => Promise<Outcome>) => {
      dispatch({ type: 'busy', slug, on: true });
      const outcome = await work().catch((err: Error): Outcome => ({ kind: 'done', text: err.message, tone: 'error' }));
      dispatch({ type: 'busy', slug, on: false });
      await report(outcome);
    },
    [report],
  );

  const execute = useCallback(
    (cmd: Command) => {
      const state = ref.current;
      const current = selectedEpic(state);
      switch (cmd.type) {
        case 'quit':
          return exit();
        case 'run':
          if (!current) return;
          dispatch({ type: 'message', text: `Running ${current.slug}…`, tone: 'info' });
          return void withBusy(current.slug, () => runSelected(deps, current.slug, cmd.force));
        case 'sync':
          if (!current) return;
          return void withBusy(current.slug, () => syncSelected(deps, current.slug));
        case 'submit': {
          dispatch({ type: 'prompt', prompt: undefined });
          const work = () => submitPrompt(deps, state, cmd.prompt);
          // Approving code pushes and opens an MR, so it shows as busy like a run.
          if (current && cmd.prompt.kind === 'approve' && cmd.prompt.context) return void withBusy(current.slug, work);
          return void work()
            .catch((err: Error): Outcome => ({ kind: 'done', text: err.message, tone: 'error' }))
            .then(report);
        }
        case 'edit': {
          const path = editablePath(deps, state, currentView(state));
          if (!path) return;
          const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
          return void suspendTerminal(() => {
            spawnSync(`${editor} "${path}"`, { shell: true, stdio: 'inherit' });
          }).then(() => {
            setRefresh((n) => n + 1);
            dispatch({ type: 'message', text: 'Saved. Anything blocking approval is listed at the bottom.', tone: 'info' });
          });
        }
      }
    },
    [deps, exit, report, suspendTerminal, withBusy],
  );

  const mainHeight = Math.max(10, rows - 6);
  const viewerHeight = Math.max(5, mainHeight - (e ? 5 + Math.min(7, e.changes.length) + (e.lastError ? 1 : 0) : 0));
  const page = Math.max(1, viewerHeight - 4);

  useInput((input, key) => {
    const intent = keyToIntent(ref.current, input, key, page);
    if (!intent) return;
    if ('ui' in intent) dispatch(intent.ui);
    else execute(intent.command);
  });

  const leftWidth = Math.min(44, Math.max(30, Math.floor(columns * 0.3)));
  const waiting = s.all.filter((x) => x.owner === s.actor && needsHuman(x)).length;

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box justifyContent="space-between" paddingX={1}>
        <Text>
          <Text bold color="cyan">
            forge
          </Text>
          <Text dimColor>
            {' '}
            · {workspaceName} · {Object.keys(deps.repos).join(', ')}
          </Text>
        </Text>
        <Text>
          {s.busy.length > 0 && <Text color="cyan">{s.busy.length} running  </Text>}
          {waiting > 0 && <Text color="yellow">{waiting} of yours need you</Text>}
        </Text>
      </Box>
      <Box height={mainHeight}>
        <EpicList s={s} height={mainHeight} width={leftWidth} />
        <Box flexDirection="column" width={columns - leftWidth}>
          {e && <Detail s={s} e={e} />}
          <Viewer
            title={viewTitle(view, s)}
            lines={content.key === viewKey ? content.text.split('\n') : ['loading…']}
            scroll={s.scroll}
            height={viewerHeight}
            focused={s.focus === 'viewer'}
          />
        </Box>
      </Box>
      <Activity lines={s.activity} />
      <Footer s={s} />
    </Box>
  );
};
