/**
 * Modal dialogs: notes and feedback, new epic, send back, owner, settings, and the welcome screen.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ConnectionInfo, GitlabAccess, GitlabAuth, WorkspaceInfo } from '../../shared/api.ts';
import { coreMachine, gitlabAccessView, type NoteSpec } from '../model.ts';
import { Button } from './ui.tsx';

export const Modal = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
};

export const useSubmit = (fn: () => Promise<void> | void) => {
  const [pending, setPending] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  };
  return { pending, submit };
};

export const NoteDialog = ({ spec, onSubmit, onClose }: { spec: NoteSpec; onSubmit: (note: string) => Promise<void>; onClose: () => void }) => {
  const [note, setNote] = useState('');
  const { pending, submit } = useSubmit(() => onSubmit(note.trim()));
  const blocked = spec.required && !note.trim();
  return (
    <Modal title={spec.title} onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          {spec.label}
          <textarea
            autoFocus
            rows={5}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !blocked && void submit()}
          />
        </label>
        <p className="muted small">Ctrl/⌘ + Enter to submit.</p>
        <div className="modal-actions">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind={spec.confirm.startsWith('Abandon') || spec.confirm.startsWith('Drop') ? 'danger' : 'primary'} type="submit" disabled={blocked || pending}>
            {pending ? 'Working…' : spec.confirm}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export const NewEpicDialog = ({ onSubmit, onClose }: { onSubmit: (title: string, idea: string) => Promise<void>; onClose: () => void }) => {
  const [title, setTitle] = useState('');
  const [idea, setIdea] = useState('');
  const { pending, submit } = useSubmit(() => onSubmit(title.trim(), idea.trim()));
  return (
    <Modal title="New epic" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Due dates on todos" />
        </label>
        <label>
          Idea
          <textarea rows={7} value={idea} onChange={(e) => setIdea(e.target.value)} placeholder="What should change, for whom, and why. Mention every repo it touches." />
        </label>
        <p className="muted small">You will own this epic. The requirements agent reads every configured repo.</p>
        <div className="modal-actions">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" disabled={!title.trim() || pending}>
            Create epic
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export const BackDialog = ({ onSubmit, onClose }: { onSubmit: (to: 'requirements' | 'spec', note: string) => Promise<void>; onClose: () => void }) => {
  const [to, setTo] = useState<'requirements' | 'spec'>('spec');
  const [note, setNote] = useState('');
  const { pending, submit } = useSubmit(() => onSubmit(to, note.trim()));
  return (
    <Modal title="Send back" onClose={onClose}>
      <form onSubmit={submit}>
        <fieldset className="radio-row">
          <label>
            <input type="radio" checked={to === 'requirements'} onChange={() => setTo('requirements')} /> Requirements
          </label>
          <label>
            <input type="radio" checked={to === 'spec'} onChange={() => setTo('spec')} /> Epic spec
          </label>
        </fieldset>
        <label>
          Why
          <textarea autoFocus rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <p className="muted small">Draft change specs are discarded. This isn't possible once a change has code.</p>
        <div className="modal-actions">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" disabled={!note.trim() || pending}>
            Send back
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export const AssignDialog = ({ owner, onSubmit, onClose }: { owner: string; onSubmit: (owner: string) => Promise<void>; onClose: () => void }) => {
  const [value, setValue] = useState(owner);
  const { pending, submit } = useSubmit(() => onSubmit(value.trim()));
  return (
    <Modal title="Epic owner" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Owner email
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="modal-actions">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" type="submit" disabled={!value.trim() || value.trim() === owner || pending}>
            Change owner
          </Button>
        </div>
      </form>
    </Modal>
  );
};

const TokenForm = ({ workspace, onToken }: { workspace: WorkspaceInfo; onToken: (token: string | null) => Promise<void> }) => {
  const [token, setToken] = useState('');
  const save = useSubmit(() => onToken(token.trim()));
  const clear = useSubmit(() => onToken(null));
  return (
    <>
      <p className="muted small">
        Never shown to agents. Status: <strong>{workspace.gitlabTokenSet ? 'set' : 'not set'}</strong> (<code>{workspace.tokenEnv}</code>).
      </p>
      {workspace.canStoreToken ? (
        <form onSubmit={save.submit} className="inline-form">
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="glpat-…" aria-label="GitLab token" />
          <Button kind="primary" type="submit" disabled={!token.trim() || save.pending}>
            Save to keychain
          </Button>
          {workspace.gitlabTokenSet && (
            <Button kind="ghost" onClick={() => void clear.submit()}>
              Remove
            </Button>
          )}
        </form>
      ) : (
        <p className="banner banner-info">
          The OS keychain isn't available, so forge won't store the token. Set <code>{workspace.tokenEnv}</code> in the environment that starts the app.
        </p>
      )}
    </>
  );
};

const GlabStatus = ({ connection }: { connection: ConnectionInfo }) => {
  const [access, setAccess] = useState<GitlabAccess | null | undefined>();
  const check = useSubmit(async () => {
    setAccess(undefined);
    setAccess(await window.forge.gitlabAccess());
  });
  useEffect(() => void check.submit(), []);
  const view = access ? gitlabAccessView(access, connection) : undefined;
  return (
    <div className={`banner banner-${view?.tone ?? 'info'} banner-with-action`} role="status">
      <span>
        {view?.text ?? `Checking the glab login on ${coreMachine(connection)}…`}
        {view?.command && (
          <>
            {' '}
            <code>{view.command}</code>
          </>
        )}
      </span>
      <Button kind="ghost" onClick={() => void check.submit()} disabled={check.pending}>
        Check again
      </Button>
    </div>
  );
};

export const SettingsDialog = ({
  workspace,
  connection,
  onToken,
  onAuth,
  onRepos,
  onClose,
}: {
  workspace: WorkspaceInfo;
  connection: ConnectionInfo;
  onToken: (token: string | null) => Promise<void>;
  onAuth: (auth: GitlabAuth) => Promise<void>;
  onRepos: () => void;
  onClose: () => void;
}) => {
  const machine = coreMachine(connection);
  const [switching, setSwitching] = useState(false);
  const choose = async (auth: GitlabAuth) => {
    if (auth === workspace.gitlabAuth || switching) return;
    setSwitching(true);
    try {
      await onAuth(auth);
    } finally {
      setSwitching(false);
    }
  };
  return (
    <Modal title="Settings" onClose={onClose}>
      <section className="settings-section">
        <h3>GitLab sign-in</h3>
        <p className="muted small">
          How forge opens and reads merge requests on <code>{workspace.gitlabHost}</code>. Branches are pushed with the git credentials of {machine} either way. Saved for{' '}
          {machine} only, in <code>.forge/local.yaml</code>.
        </p>
        <fieldset className="radio-row" aria-label="GitLab sign-in">
          <label>
            <input type="radio" name="gitlab-auth" checked={workspace.gitlabAuth === 'token'} disabled={switching} onChange={() => void choose('token')} /> GitLab token
          </label>
          <label>
            <input type="radio" name="gitlab-auth" checked={workspace.gitlabAuth === 'glab'} disabled={switching} onChange={() => void choose('glab')} /> GitLab CLI (glab) login on {machine}
          </label>
        </fieldset>
        {workspace.gitlabAuth === 'glab' ? <GlabStatus connection={connection} /> : <TokenForm workspace={workspace} onToken={onToken} />}
      </section>
      <section className="settings-section">
        <h3>Workspace</h3>
        <p className="small">
          <code>{workspace.root}</code>
        </p>
        <ul className="small">
          {workspace.repos.map((r) => (
            <li key={r.name}>
              <strong>{r.name}</strong> <code>{r.root}</code> → GitLab <code>{r.project}</code> {r.present ? '' : '⚠ missing clone'}
            </li>
          ))}
        </ul>
        {workspace.warnings.length > 0 && (
          <div className="banner banner-bad">
            {workspace.warnings.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
        )}
        <Button kind="secondary" onClick={onRepos}>
          Edit repositories…
        </Button>
      </section>
      <div className="modal-actions">
        <Button kind="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
};

export const Welcome = ({
  recent,
  error,
  connection,
  onChoose,
  onOpen,
  onSetup,
  onConnect,
  onDisconnect,
}: {
  recent: readonly string[];
  error?: string;
  connection: ConnectionInfo;
  onChoose: () => void;
  onOpen: (root: string) => void;
  onSetup: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) => {
  const remote = connection.kind === 'remote' ? connection : undefined;
  return (
    <div className="welcome">
      <h1>
        <span className="logo">forge</span>
      </h1>
      <p>Epics to merge requests, with a human decision at every step.</p>
      {remote && (
        <div className="banner banner-info connection-banner">
          <span>
            Connected to <strong>{remote.label}</strong>. Workspaces, agents and checks run there.
          </span>
          <Button kind="ghost" onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      )}
      {error && <div className="banner banner-bad">{error}</div>}
      <div className="actions" style={{ justifyContent: 'flex-start' }}>
        <Button kind="primary" onClick={onChoose}>
          {remote ? 'Open workspace on the server…' : 'Open workspace…'}
        </Button>
        <Button kind="secondary" onClick={onSetup}>
          Set up a new workspace…
        </Button>
        {!remote && (
          <Button kind="secondary" onClick={onConnect}>
            Connect to SSH server…
          </Button>
        )}
      </div>
      <p className="muted small">
        Open a planning repo (or a code repo) that has .forge/config.yaml, or set up forge in an empty planning repo and add your code repos.
        {!remote && ' To run everything on another machine, connect to it over SSH.'}
      </p>
      {recent.length > 0 && (
        <>
          <h2>{remote ? `Recent on ${remote.label}` : 'Recent'}</h2>
          <ul className="recent">
            {recent.map((r) => (
              <li key={r}>
                <button onClick={() => onOpen(r)}>{r}</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};
