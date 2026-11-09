/**
 * The app's own updates: a notice when there is something to do, and the Updates section of Settings.
 */
import { canCheckForUpdates, type UpdateStatus, type UpdateView } from '../../shared/api.ts';
import { Button } from './ui.tsx';

type Of<K extends UpdateStatus['kind']> = Extract<UpdateStatus, { kind: K }>;

const SUMMARY: { readonly [K in UpdateStatus['kind']]: (status: Of<K>) => string } = {
  off: (s) => s.reason,
  idle: () => 'Checks for updates shortly after start, then every few hours.',
  checking: () => 'Checking for updates…',
  current: (s) => `Up to date. Last checked ${new Date(s.checkedAt).toLocaleString()}.`,
  downloading: (s) => `Downloading forge ${s.version} (${s.percent}%).`,
  ready: (s) => `Forge ${s.version} is downloaded. It installs when you restart or quit.${s.problem ? ` The last install failed: ${s.problem}` : ''}`,
  installing: (s) => `Installing forge ${s.version}…`,
  manual: (s) => `Forge ${s.version} is out. This Mac build can't install it by itself, so download it from the release page.`,
  failed: (s) => `The last check failed: ${s.message}`,
};

const summary = (status: UpdateStatus): string => (SUMMARY[status.kind] as (s: UpdateStatus) => string)(status);

/** Shown in the sidebar (or on the welcome screen) only when an update waits for the user. */
export const UpdateNotice = ({ update, onRestart, onOpen }: { update: UpdateView | undefined; onRestart: () => void; onOpen: (url: string) => void }) => {
  const status = update?.status;
  if (status?.kind === 'ready')
    return (
      <div className="banner banner-info banner-with-action update-notice">
        <span>Forge {status.version} is ready.</span>
        <Button kind="primary" onClick={onRestart}>
          Restart
        </Button>
      </div>
    );
  if (status?.kind === 'installing') return <div className="banner banner-info update-notice">Installing forge {status.version}…</div>;
  if (status?.kind === 'manual')
    return (
      <div className="banner banner-info banner-with-action update-notice">
        <span>Forge {status.version} is out.</span>
        <Button kind="secondary" onClick={() => onOpen(status.url)}>
          Download
        </Button>
      </div>
    );
  return null;
};

export const UpdateSection = ({ update, onCheck }: { update: UpdateView | undefined; onCheck: () => void }) => {
  if (!update) return null;
  return (
    <section className="settings-section">
      <h3>Updates</h3>
      <p className="muted small">
        Version <strong>{update.version}</strong>. {summary(update.status)}
      </p>
      {update.status.kind !== 'off' && (
        <Button kind="secondary" onClick={onCheck} disabled={!canCheckForUpdates(update.status)}>
          Check for updates
        </Button>
      )}
    </section>
  );
};
