/**
 * Repositories: add, edit and remove the code repos a workspace can change. Also used to set up a
 * new workspace. Writes .forge/config.yaml (shared) and .forge/local.yaml (this machine) in main.
 */
import { useEffect, useState } from 'react';
import type { Outcome, RepoEdit, RepoGuess } from '../../shared/api.ts';
import { DEFAULT_GITLAB_URL, gitlabHostMismatch } from '../../shared/gitlab.ts';
import { Button, Chip } from './ui.tsx';

type Card = RepoEdit & {
  readonly key: number;
  readonly resolved?: string;
  readonly present?: boolean;
  readonly remoteHost?: string;
  readonly inUse: readonly string[];
  readonly warnings: readonly string[];
};

let nextKey = 0;

const fromGuess = (g: RepoGuess): Card => ({
  key: nextKey++,
  name: g.name,
  path: g.path,
  localPath: '',
  project: g.project,
  baseBranch: g.baseBranch,
  remote: g.remote,
  setup: g.setup,
  checks: g.checks.length ? g.checks : [{ name: 'test', run: '' }],
  revertCheck: g.checks[0]?.name ?? 'test',
  resolved: g.root,
  present: g.isGit,
  remoteHost: g.remoteHost,
  inUse: [],
  warnings: g.warnings,
});

const toEdit = ({ key: _k, resolved: _r, present: _p, remoteHost: _h, inUse: _i, warnings: _w, ...edit }: Card): RepoEdit => edit;

const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

const RepoCard = ({
  card,
  gitlabUrl,
  onChange,
  onRemove,
  onBrowse,
  onUseGitlabHost,
}: {
  card: Card;
  gitlabUrl: string;
  onChange: (c: Card) => void;
  onRemove: () => void;
  onBrowse: (target: 'shared' | 'local') => void;
  onUseGitlabHost: (host: string) => void;
}) => {
  const mismatch = gitlabHostMismatch(card.remoteHost ?? '', gitlabUrl);
  const set = <K extends keyof Card>(k: K, v: Card[K]) => onChange({ ...card, [k]: v });
  const checkNames = card.checks.map((c) => c.name).filter(Boolean);
  return (
    <section className="repo-card">
      <header className="repo-card-head">
        <input className="repo-name" value={card.name} onChange={(e) => set('name', e.target.value.toLowerCase())} aria-label="Repo name" placeholder="name" />
        {card.present === false && <Chip tone="bad">no clone found</Chip>}
        {card.present && <Chip>clone found</Chip>}
        <span className="spacer" />
        <Button kind="danger" onClick={onRemove} disabled={card.inUse.length > 0} title={card.inUse.length ? `Used by ${card.inUse.join(', ')}` : 'Remove this repo'}>
          Remove
        </Button>
      </header>
      {card.inUse.length > 0 && <p className="muted small">Used by unfinished changes: {card.inUse.join(', ')}</p>}
      {card.warnings.map((w) => (
        <div key={w} className="banner banner-info small">
          {w}
        </div>
      ))}
      {mismatch && (
        <div className="banner banner-info small banner-with-action">
          <span>{mismatch}</span>
          <Button kind="secondary" onClick={() => onUseGitlabHost(card.remoteHost!)}>
            Use https://{card.remoteHost}
          </Button>
        </div>
      )}
      <div className="repo-grid">
        <Field label="Path (shared)" hint="Relative to the planning repo; the team's convention, e.g. ../templo-backend.">
          <span className="with-button">
            <input value={card.path} onChange={(e) => set('path', e.target.value)} placeholder="../repo" />
            <Button kind="ghost" onClick={() => onBrowse('shared')}>
              Browse…
            </Button>
          </span>
        </Field>
        <Field label="Path on this machine" hint="Only if your clone is elsewhere. Saved in .forge/local.yaml, not committed.">
          <span className="with-button">
            <input value={card.localPath} onChange={(e) => set('localPath', e.target.value)} placeholder="same as shared" />
            <Button kind="ghost" onClick={() => onBrowse('local')}>
              Browse…
            </Button>
          </span>
        </Field>
        <Field label="GitLab project" hint="group/subgroup/project, or the numeric id.">
          <input value={card.project} onChange={(e) => set('project', e.target.value)} placeholder="group/project" />
        </Field>
        <Field label="Base branch" hint="Changes branch from and merge into this.">
          <input value={card.baseBranch} onChange={(e) => set('baseBranch', e.target.value)} placeholder="main" />
        </Field>
        <Field label="Setup commands" hint="Run once in each new worktree, one per line (e.g. npm ci).">
          <textarea rows={2} value={card.setup.join('\n')} onChange={(e) => set('setup', e.target.value.split('\n'))} />
        </Field>
        <Field label="Checks" hint="Must all pass before a change counts as built. Mirror your CI.">
          <div className="checks">
            {card.checks.map((c, i) => (
              <div key={i} className="check-row">
                <input className="check-name" value={c.name} placeholder="name" onChange={(e) => set('checks', card.checks.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input value={c.run} placeholder="npm test" onChange={(e) => set('checks', card.checks.map((x, j) => (j === i ? { ...x, run: e.target.value } : x)))} />
                <button className="icon-btn" aria-label="Remove check" onClick={() => set('checks', card.checks.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
            <Button kind="ghost" onClick={() => set('checks', [...card.checks, { name: '', run: '' }])}>
              + Add check
            </Button>
          </div>
        </Field>
        <Field label="Revert test uses" hint="For feature and fix changes, this check must fail with the change reverted.">
          <select value={card.revertCheck} onChange={(e) => set('revertCheck', e.target.value)}>
            {[...new Set([card.revertCheck, ...checkNames])].filter(Boolean).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </section>
  );
};

export const RepoDialog = ({ setupRoot, onClose, onSaved }: { setupRoot: string | null; onClose: () => void; onSaved: (o: Outcome) => Promise<void> }) => {
  const [cards, setCards] = useState<Card[] | undefined>(setupRoot ? [] : undefined);
  const [gitlabUrl, setGitlabUrl] = useState(DEFAULT_GITLAB_URL);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (setupRoot) return;
    void window.forge.repoSettings().then((s) => {
      setCards((s?.repos ?? []).map((r) => ({ ...r, key: nextKey++, warnings: [] })));
      if (s) setGitlabUrl(s.gitlabBaseUrl);
    });
  }, [setupRoot]);

  const add = async () => {
    const guess = await window.forge.inspectRepo(null, setupRoot);
    if (guess) setCards((cs) => [...(cs ?? []), fromGuess(guess)]);
  };

  const browse = async (key: number, target: 'shared' | 'local') => {
    const guess = await window.forge.inspectRepo(null, setupRoot);
    if (!guess) return;
    setCards((cs) =>
      (cs ?? []).map((c) =>
        c.key !== key
          ? c
          : {
              ...c,
              ...(target === 'shared' ? { path: guess.path } : { localPath: guess.root }),
              project: c.project || guess.project,
              resolved: guess.root,
              present: guess.isGit,
              remoteHost: guess.remoteHost,
              warnings: guess.warnings,
            },
      ),
    );
  };

  const save = async () => {
    if (!cards) return;
    setSaving(true);
    setError(undefined);
    const cleaned = cards.map((c) => toEdit({ ...c, setup: c.setup.map((s) => s.trim()).filter(Boolean) }));
    const outcome = await window.forge.saveRepos(cleaned, setupRoot, gitlabUrl);
    setSaving(false);
    if (!outcome.ok) return setError(outcome.text);
    await onSaved(outcome);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="Repositories">
        <h2>{setupRoot ? 'Set up a new workspace' : 'Repositories'}</h2>
        <p className="muted small">
          {setupRoot ? (
            <>
              Forge will create <code>.forge/config.yaml</code> and <code>AGENTS.md</code> in <code>{setupRoot}</code>. Add the code repos epics can change.
            </>
          ) : (
            <>
              Saved to <code>.forge/config.yaml</code> (commit it so the team shares it). Paths for this machine only go to <code>.forge/local.yaml</code>.
            </>
          )}
        </p>
        <Field label="GitLab URL" hint="The GitLab instance your repos live on; forge pushes branches and opens merge requests there.">
          <input value={gitlabUrl} onChange={(e) => setGitlabUrl(e.target.value)} placeholder={DEFAULT_GITLAB_URL} aria-label="GitLab URL" />
        </Field>
        {!cards && <p className="muted">Loading…</p>}
        {cards?.length === 0 && <p className="empty">No repositories yet. Add the clones of your code repos.</p>}
        {cards?.map((card) => (
          <RepoCard
            key={card.key}
            card={card}
            onChange={(next) => setCards((cs) => (cs ?? []).map((c) => (c.key === card.key ? next : c)))}
            onRemove={() => setCards((cs) => (cs ?? []).filter((c) => c.key !== card.key))}
            gitlabUrl={gitlabUrl}
            onBrowse={(target) => void browse(card.key, target)}
            onUseGitlabHost={(host) => setGitlabUrl(`https://${host}`)}
          />
        ))}
        {error && <div className="banner banner-bad">{error}</div>}
        <div className="modal-actions">
          <Button kind="secondary" onClick={() => void add()}>
            + Add repository…
          </Button>
          <span className="spacer" />
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => void save()} disabled={saving || !cards || cards.length === 0}>
            {saving ? 'Saving…' : setupRoot ? 'Create workspace' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
};
