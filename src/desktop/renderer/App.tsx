/**
 * Desktop app root: state, subscriptions to the main process, and the action runner.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ConnectionInfo, FolderRequest, Outcome } from '../shared/api.ts';
import { ChatPanel } from './components/ChatPanel.tsx';
import { AssignDialog, BackDialog, NewEpicDialog, NoteDialog, SettingsDialog, Welcome } from './components/Dialogs.tsx';
import { DocPanel } from './components/DocPanel.tsx';
import { ConnectDialog, RemoteFolderPicker } from './components/Remote.tsx';
import { RepoDialog } from './components/RepoDialog.tsx';
import { ChangeBar, ChangeList, EpicHeader } from './components/Epic.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { chatThreads, currentTab, currentView, initialState, reducer, selectedChange, selectedEpic, stageView, tabsFor, type ActionSpec } from './model.ts';

const api = () => window.forge;

/** Whether the chat panel is hidden: a per-viewer preference, so browser storage (when it is available). */
const CHAT_HIDDEN_KEY = 'forge.chatHidden';
const readChatHidden = (): boolean => {
  try {
    return localStorage.getItem(CHAT_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
};
const writeChatHidden = (hidden: boolean) => {
  try {
    localStorage.setItem(CHAT_HIDDEN_KEY, hidden ? '1' : '0');
  } catch {
    // Not remembered; it still works for this session.
  }
};

const Toast = ({ toast, onClose }: { toast: Outcome & { id: number }; onClose: () => void }) => {
  useEffect(() => {
    if (toast.tone === 'error') return;
    const t = setTimeout(onClose, 6000);
    return () => clearTimeout(t);
  }, [toast.id]);
  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      <span>{toast.text}</span>
      <button className="icon-btn" onClick={onClose} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
};

export const App = () => {
  const [s, dispatch] = useReducer(reducer, initialState);
  const [workspaceError, setWorkspaceError] = useState<string | undefined>();
  const [connection, setConnection] = useState<ConnectionInfo>({ kind: 'local' });
  const [connecting, setConnecting] = useState(false);
  const [folderRequest, setFolderRequest] = useState<FolderRequest | undefined>();
  const [chatHidden, setChatHidden] = useState(readChatHidden);
  const toggleChat = (hidden: boolean) => {
    setChatHidden(hidden);
    writeChatHidden(hidden);
  };
  const ref = useRef(s);
  ref.current = s;

  const reload = useCallback(async (select?: string) => {
    dispatch({ type: 'epics', epics: await api().listEpics(), select });
  }, []);

  /** Reloads everything from the active backend (this machine, or the connected SSH host). */
  const refresh = useCallback(async () => {
    const [workspace, recent, busy, conn] = await Promise.all([api().workspace(), api().recentWorkspaces(), api().busy(), api().connection()]);
    setConnection(conn);
    dispatch({ type: 'workspace', workspace, recent });
    dispatch({ type: 'busy', busy });
    if (workspace) await reload();
  }, [reload]);

  useEffect(() => {
    void refresh();
    const offs = [
      api().onEpicsChanged(() => void reload()),
      api().onBusy((busy) => dispatch({ type: 'busy', busy })),
      api().onConnectionChanged((change) => {
        setWorkspaceError(undefined);
        setFolderRequest(undefined);
        if (change.error) dispatch({ type: 'toast', outcome: { ok: false, text: change.error, tone: 'error' } });
        void refresh();
      }),
      api().onPickFolder(setFolderRequest),
    ];
    return () => offs.forEach((off) => off());
  }, [reload, refresh]);

  const disconnect = async () => dispatch({ type: 'toast', outcome: await api().disconnectRemote() });

  const remoteDialogs = (
    <>
      {connecting && <ConnectDialog onClose={() => setConnecting(false)} onConnected={() => setConnecting(false)} />}
      {folderRequest && <RemoteFolderPicker request={folderRequest} onDone={() => setFolderRequest(undefined)} />}
    </>
  );

  const show = useCallback(
    async (o: Outcome) => {
      await reload(o.select);
      dispatch({ type: 'toast', outcome: o });
    },
    [reload],
  );

  const switchTo = async (result: Promise<{ workspace: typeof s.workspace; error?: string }>) => {
    const r = await result;
    setWorkspaceError(r.error);
    if (r.error) dispatch({ type: 'toast', outcome: { ok: false, text: r.error, tone: 'error' } });
    dispatch({ type: 'workspace', workspace: r.workspace, recent: await api().recentWorkspaces() });
    if (r.workspace) await reload();
  };

  /** Runs an action, asking for a note first when the action needs one. */
  const perform = async (a: ActionSpec, note = '') => {
    const epic = selectedEpic(ref.current);
    if (!epic) return;
    const slug = epic.slug;
    switch (a.id) {
      case 'back':
        return dispatch({ type: 'dialog', dialog: { kind: 'back', slug } });
      case 'assign':
        return dispatch({ type: 'dialog', dialog: { kind: 'assign', slug, owner: epic.owner } });
      case 'stop':
        return api().stop(slug);
      case 'answer':
        dispatch({ type: 'view', view: epic.dialog?.stage });
        return dispatch({ type: 'tab', tab: 'questions' });
    }
    if (a.note && ref.current.dialog?.kind !== 'note') return dispatch({ type: 'dialog', dialog: { kind: 'note', action: a, slug } });
    dispatch({ type: 'dialog', dialog: undefined });
    const outcome =
      a.id === 'run'
        ? await api().run(slug, false)
        : a.id === 'force-run'
          ? await api().run(slug, true)
          : a.id === 'approve'
            ? await api().approve(slug, a.changeId ?? null, note)
            : a.id === 'approve-all'
              ? await api().approveAll(slug, note)
              : a.id === 'revise'
                ? await api().revise(slug, a.changeId ?? null, note)
                : a.id === 'drop'
                  ? await api().drop(slug, a.changeId!, note)
                  : a.id === 'abandon'
                    ? await api().abandon(slug, note)
                    : await api().sync(slug);
    await show(outcome);
  };

  const afterRepos = async (o: Outcome) => {
    dispatch({ type: 'dialog', dialog: undefined });
    dispatch({ type: 'workspace', workspace: await api().workspace(), recent: await api().recentWorkspaces() });
    await reload();
    dispatch({ type: 'toast', outcome: o });
  };

  if (!s.workspace)
    return (
      <>
        <Welcome
          recent={s.recent}
          error={workspaceError}
          connection={connection}
          onConnect={() => setConnecting(true)}
          onDisconnect={() => void disconnect()}
          onChoose={() => void switchTo(api().chooseWorkspace())}
          onOpen={(root) => void switchTo(api().openWorkspace(root))}
          onSetup={async () => {
            const r = await api().chooseNewWorkspace();
            setWorkspaceError(r.error);
            if (r.root) dispatch({ type: 'dialog', dialog: { kind: 'repos', setupRoot: r.root } });
          }}
        />
        {s.dialog?.kind === 'repos' && (
          <RepoDialog setupRoot={s.dialog.setupRoot} onClose={() => dispatch({ type: 'dialog', dialog: undefined })} onSaved={afterRepos} />
        )}
        {remoteDialogs}
        {s.toast && <Toast toast={s.toast} onClose={() => dispatch({ type: 'toast', outcome: undefined })} />}
      </>
    );

  const epic = selectedEpic(s);
  const change = selectedChange(s);
  const busy = epic ? s.busy.includes(epic.slug) : false;
  const view = currentView(s);
  const tab = currentTab(s);
  const dialog = s.dialog;
  const showChanges = (view === 'changes' || view === 'development') && !!epic?.changes.length;
  const threads = epic ? chatThreads(epic, view, showChanges ? change : undefined) : [];
  const chatOpen = threads.length > 0 && !chatHidden;

  return (
    <div className="app">
      <Sidebar
        state={s}
        workspace={s.workspace}
        connection={connection}
        onConnect={() => setConnecting(true)}
        onDisconnect={() => void disconnect()}
        onSelect={(slug) => dispatch({ type: 'select', slug })}
        onFilter={(filter) => dispatch({ type: 'filter', filter })}
        onNew={() => dispatch({ type: 'dialog', dialog: { kind: 'new-epic' } })}
        onSwitch={() => void switchTo(api().chooseWorkspace())}
        onSettings={() => dispatch({ type: 'dialog', dialog: { kind: 'settings' } })}
        onRepos={() => dispatch({ type: 'dialog', dialog: { kind: 'repos', setupRoot: null } })}
      />
      <main className="main">
        {!epic ? (
          <div className="empty-main">
            <h2>No epic selected</h2>
            <p className="muted">Create an epic to start: describe the idea, and forge works out its requirements against every repo in this workspace.</p>
          </div>
        ) : (
          <>
            <EpicHeader
              epic={epic}
              busy={busy}
              actor={s.workspace.actor}
              view={view}
              onView={(stage) => dispatch({ type: 'view', view: stage })}
              onAction={(a) => void perform(a)}
              onAssign={() => void perform({ id: 'assign', label: '', kind: 'secondary' })}
            />
            <div className={`epic-body${showChanges ? ' with-changes' : ''}${chatOpen ? ' with-chat' : ''}`}>
              {showChanges && <ChangeList epic={epic} selected={change?.id} onSelect={(id) => dispatch({ type: 'select-change', changeId: id })} />}
              <div className="epic-content">
                {showChanges && change && (
                  <ChangeBar
                    change={change}
                    stage={epic.stage}
                    readOnly={view !== stageView(epic)}
                    busy={busy}
                    onAction={(a) => void perform(a)}
                    onOpenUrl={(u) => void api().openExternal(u)}
                  />
                )}
                {view === 'changes' && !epic.changes.length && (
                  <p className="muted empty-stage">No change specs yet. Run the epic to draft them from the approved epic spec.</p>
                )}
                <DocPanel
                  epic={epic}
                  view={view}
                  change={showChanges ? change : undefined}
                  tabs={tabsFor(epic, view, showChanges ? change : undefined)}
                  tab={tab}
                  revision={s.revision}
                  onTab={(t) => dispatch({ type: 'tab', tab: t })}
                  onSaved={(o) => {
                    dispatch({ type: 'saved' });
                    void show(o);
                  }}
                  onOpenUrl={(u) => void api().openExternal(u)}
                  busy={busy}
                />
              </div>
              {chatOpen ? (
                <ChatPanel
                  epic={epic}
                  threads={threads}
                  actor={s.workspace.actor}
                  busy={busy}
                  onSend={async (thread, text) => {
                    const o = await api().chat(epic.slug, thread, text);
                    await reload();
                    // The reply shows in the thread; only say more when something else happened.
                    if (o.text) dispatch({ type: 'toast', outcome: o });
                    return o;
                  }}
                  onOpenUrl={(u) => void api().openExternal(u)}
                  onCollapse={() => toggleChat(true)}
                />
              ) : (
                threads.length > 0 && (
                  <button className="chat-reopen" onClick={() => toggleChat(false)} title="Chat with the agent">
                    Chat
                  </button>
                )
              )}
            </div>
          </>
        )}
      </main>

      {dialog?.kind === 'note' && dialog.action.note && (
        <NoteDialog spec={dialog.action.note} onClose={() => dispatch({ type: 'dialog', dialog: undefined })} onSubmit={(note) => perform(dialog.action, note)} />
      )}
      {dialog?.kind === 'new-epic' && (
        <NewEpicDialog
          onClose={() => dispatch({ type: 'dialog', dialog: undefined })}
          onSubmit={async (title, idea) => {
            const o = await api().createEpic(title, idea);
            if (o.ok) dispatch({ type: 'dialog', dialog: undefined });
            await show(o);
          }}
        />
      )}
      {dialog?.kind === 'back' && (
        <BackDialog
          onClose={() => dispatch({ type: 'dialog', dialog: undefined })}
          onSubmit={async (to, note) => {
            dispatch({ type: 'dialog', dialog: undefined });
            await show(await api().sendBack(dialog.slug, to, note));
          }}
        />
      )}
      {dialog?.kind === 'assign' && (
        <AssignDialog
          owner={dialog.owner}
          onClose={() => dispatch({ type: 'dialog', dialog: undefined })}
          onSubmit={async (owner) => {
            dispatch({ type: 'dialog', dialog: undefined });
            await show(await api().assign(dialog.slug, owner));
          }}
        />
      )}
      {dialog?.kind === 'settings' && (
        <SettingsDialog
          workspace={s.workspace}
          onClose={() => dispatch({ type: 'dialog', dialog: undefined })}
          onRepos={() => dispatch({ type: 'dialog', dialog: { kind: 'repos', setupRoot: null } })}
          onToken={async (token) => {
            const o = await api().setGitlabToken(token);
            dispatch({ type: 'toast', outcome: o });
            dispatch({ type: 'workspace', workspace: await api().workspace() });
            await reload();
          }}
        />
      )}
      {dialog?.kind === 'repos' && <RepoDialog setupRoot={dialog.setupRoot} onClose={() => dispatch({ type: 'dialog', dialog: undefined })} onSaved={afterRepos} />}
      {remoteDialogs}
      {s.toast && <Toast toast={s.toast} onClose={() => dispatch({ type: 'toast', outcome: undefined })} />}
    </div>
  );
};
