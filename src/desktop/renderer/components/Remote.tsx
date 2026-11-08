/**
 * Remote workspaces: connecting to an SSH host (password, key file or SSH agent), and browsing the
 * host's folders when forge, running there, asks for one.
 */
import { useEffect, useState } from 'react';
import type { ConnectionInfo, ConnectRequest, DirListing, FolderRequest, HostEntry, SshAuthKind } from '../../shared/api.ts';
import { Modal, useSubmit } from './Dialogs.tsx';
import { Button, Chip } from './ui.tsx';

const api = () => window.forge;

type Form = Omit<ConnectRequest, 'port' | 'trustFingerprint'> & { readonly port: string };

const blank: Form = { host: '', port: '22', username: '', auth: 'password', password: '', rememberPassword: true, keyPath: '', passphrase: '', forwardClaude: true };

const fromHost = (h: HostEntry): Form => ({
  ...blank,
  host: h.host,
  port: String(h.port),
  username: h.username,
  auth: h.auth,
  keyPath: h.keyPath,
  rememberPassword: h.savedPassword,
  forwardClaude: h.forwardClaude,
});

/** "user@host:2222" or "user@host" fills the form fields. */
export const parseDestination = (text: string): Partial<Pick<Form, 'host' | 'port' | 'username'>> => {
  const m = text.trim().match(/^(?:([^@\s]+)@)?([^:@\s]+)(?::(\d{1,5}))?$/);
  return m ? { username: m[1], host: m[2], port: m[3] } : {};
};

export const ConnectDialog = ({ onClose, onConnected }: { onClose: () => void; onConnected: (c: ConnectionInfo) => void }) => {
  const [hosts, setHosts] = useState<readonly HostEntry[]>([]);
  const [form, setForm] = useState<Form>(blank);
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [hostKey, setHostKey] = useState<{ fingerprint: string; changed: boolean } | undefined>();

  useEffect(() => {
    void api()
      .savedHosts()
      .then((h) => {
        setHosts(h);
        if (h[0]) setForm(fromHost(h[0]));
      });
    return api().onConnectionStatus(setStatus);
  }, []);

  const saved = hosts.find((h) => h.host === form.host.trim() && h.username === form.username.trim() && String(h.port) === form.port.trim());
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setHostKey(undefined);
  };

  const connect = useSubmit(async () => {
    setError(undefined);
    const r = await api().connectRemote({
      ...form,
      host: form.host.trim(),
      username: form.username.trim(),
      port: Number(form.port) || 22,
      trustFingerprint: hostKey?.fingerprint ?? null,
    });
    setStatus(undefined);
    if (r.ok) return onConnected(r.connection);
    setError(r.error);
    setHostKey(r.hostKey);
  });

  const needsPassword = form.auth === 'password' && !form.password && !saved?.savedPassword;
  const ready = form.host.trim() && form.username.trim() && Number(form.port) > 0 && !needsPassword;

  return (
    <Modal title="Connect to an SSH server" onClose={onClose}>
      <p className="muted small">
        Forge runs on the server: agents, git, checks and files all stay there, and this app shows the UI. The server needs Node.js 24+, npm and git; forge installs
        itself in <code>~/.forge/server</code> the first time.
      </p>
      {hosts.length > 0 && (
        <div className="saved-hosts">
          {hosts.map((h) => (
            <span key={h.id} className="saved-host">
              <button className={`chip chip-button${saved?.id === h.id ? ' on' : ''}`} onClick={() => (setForm(fromHost(h)), setHostKey(undefined), setError(undefined))}>
                {h.id}
              </button>
              <button
                className="icon-btn"
                title={`Forget ${h.id} (its saved password and trusted host key)`}
                onClick={async () => {
                  await api().forgetHost(h.id);
                  setHosts(await api().savedHosts());
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <form onSubmit={connect.submit}>
        <div className="connect-grid">
          <label>
            Host
            <input
              autoFocus
              value={form.host}
              placeholder="dev.example.com or user@host"
              onChange={(e) => {
                const v = e.target.value;
                const d = v.includes('@') || v.includes(':') ? parseDestination(v) : {};
                setForm((f) => ({ ...f, host: d.host ?? v, username: d.username ?? f.username, port: d.port ?? f.port }));
                setHostKey(undefined);
              }}
            />
          </label>
          <label>
            Port
            <input value={form.port} inputMode="numeric" onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>
        <label>
          Username
          <input value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="username" />
        </label>
        <fieldset className="radio-row">
          {(['password', 'key', 'agent'] as SshAuthKind[]).map((k) => (
            <label key={k}>
              <input type="radio" checked={form.auth === k} onChange={() => set('auth', k)} /> {k === 'password' ? 'Password' : k === 'key' ? 'Key file' : 'SSH agent'}
            </label>
          ))}
        </fieldset>
        {form.auth === 'password' && (
          <>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={form.password}
                placeholder={saved?.savedPassword ? 'Saved in the keychain' : ''}
                onChange={(e) => set('password', e.target.value)}
              />
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={form.rememberPassword} onChange={(e) => set('rememberPassword', e.target.checked)} /> Remember the password in the OS
              keychain
            </label>
          </>
        )}
        {form.auth === 'key' && (
          <>
            <label>
              Private key
              <input value={form.keyPath} placeholder="~/.ssh/id_ed25519" onChange={(e) => set('keyPath', e.target.value)} />
            </label>
            <label>
              Passphrase
              <input type="password" autoComplete="off" value={form.passphrase} placeholder="if the key has one" onChange={(e) => set('passphrase', e.target.value)} />
            </label>
          </>
        )}
        <label className="inline-check" title="ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from this app's environment. Without it, agents use whatever Claude login the server has.">
          <input type="checkbox" checked={form.forwardClaude} onChange={(e) => set('forwardClaude', e.target.checked)} /> Let agents on the server use this machine's Claude
          credentials
        </label>

        {hostKey && (
          <div className={`banner ${hostKey.changed ? 'banner-bad' : 'banner-info'}`}>
            <div>{error}</div>
            <div className="fingerprint">
              <code>{hostKey.fingerprint}</code>
            </div>
          </div>
        )}
        {error && !hostKey && <div className="banner banner-bad pre-line">{error}</div>}
        {connect.pending && status && <p className="muted small connect-status">{status}</p>}

        <div className="modal-actions">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind={hostKey?.changed ? 'danger' : 'primary'} type="submit" disabled={!ready || connect.pending}>
            {connect.pending ? 'Connecting…' : hostKey ? (hostKey.changed ? 'Trust the new key and connect' : 'Trust and connect') : 'Connect'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

/** Browses folders on the SSH host (through forge running there) and answers the folder request. */
export const RemoteFolderPicker = ({ request, onDone }: { request: FolderRequest; onDone: () => void }) => {
  const [listing, setListing] = useState<DirListing | undefined>();
  const [typed, setTyped] = useState('');

  const go = async (path: string | null) => {
    const l = await api().listDirectory(path);
    setListing(l);
    setTyped(l.path);
  };
  useEffect(() => void go(null), [request.id]);

  const answer = async (path: string | null) => {
    await api().folderPicked(request.id, path);
    onDone();
  };

  return (
    <Modal title={request.title} onClose={() => void answer(null)}>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void go(typed.trim() || null);
        }}
      >
        <Button kind="ghost" onClick={() => listing?.parent && void go(listing.parent)} disabled={!listing?.parent} title="Parent folder">
          ↑
        </Button>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Folder on the server" />
        <Button type="submit">Go</Button>
      </form>
      {listing?.error && <div className="banner banner-bad">{listing.error}</div>}
      <ul className="folder-list">
        {listing?.entries.map((e) => (
          <li key={e.path}>
            <button onClick={() => void go(e.path)} onDoubleClick={() => void answer(e.path)}>
              <span className="folder-name">{e.name}</span>
              {e.forge && <Chip tone="good">forge</Chip>}
              {e.git && <Chip>git</Chip>}
            </button>
          </li>
        ))}
        {listing && listing.entries.length === 0 && !listing.error && <li className="muted small">No folders here.</li>}
      </ul>
      <div className="modal-actions">
        <Button kind="ghost" onClick={() => void answer(null)}>
          Cancel
        </Button>
        <Button kind="primary" onClick={() => listing && void answer(listing.path)} disabled={!listing || Boolean(listing.error)}>
          Choose this folder
        </Button>
      </div>
    </Modal>
  );
};
