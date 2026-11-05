/**
 * Desktop app logic that runs without Electron: view model, IPC handlers, settings, PATH merge.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Deps } from '../src/application/deps.ts';
import type { ChangeState, Epic } from '../src/domain/epic.ts';
import { ok } from '../src/domain/result.ts';
import { createHandlers } from '../src/desktop/main/handlers.ts';
import type { Session } from '../src/desktop/main/session.ts';
import { fileSettings, type Keychain } from '../src/desktop/main/settings.ts';
import { mergePaths } from '../src/desktop/main/shellEnv.ts';
import { changeActions, currentTab, currentView, epicActions, initialState, reducer, runWouldDoSomething, stepState, tabsFor } from '../src/desktop/renderer/model.ts';
import type { Outcome } from '../src/ui/actions.ts';
import { EPIC_SPEC, makeDeps, makeRepo, REQUIREMENTS, scriptedAgent, sh, stageOf, tempDir } from './helpers.ts';

const epic = (patch: Partial<Epic> = {}): Epic => ({
  slug: 'e',
  title: 'E',
  owner: 'me@example.com',
  createdAt: '',
  updatedAt: '',
  stage: 'requirements',
  status: 'ready',
  revision: 0,
  pendingFeedback: [],
  notes: [],
  changes: [],
  costUsd: 0,
  ...patch,
});

const change = (id: string, status: ChangeState['status'], dependsOn: string[] = []): ChangeState => ({
  id,
  title: id,
  status,
  spec: status === 'draft' ? undefined : { id, title: id, repo: 'api', kind: 'feature', risk: 'low', files: ['a'], dependsOn, verification: ['v'], markdown: '' },
  specFeedback: [],
  failures: [],
  feedback: [],
  findings: [],
});

const ids = (actions: readonly { id: string }[]) => actions.map((a) => a.id);

describe('desktop view model', () => {
  it('offers the gate decision when a gate is open, and only Stop while running', () => {
    const gate = epicActions(epic({ status: 'awaiting_approval', revision: 1 }), false);
    assert.equal(gate[0]?.id, 'approve');
    assert.equal(gate[0]?.kind, 'primary');
    assert.deepEqual(ids(epicActions(epic(), true)), ['stop']);
    assert.equal(stepState(epic({ status: 'awaiting_approval' }), 'requirements'), 'gate');
  });

  it('only makes Run primary when a run would do something', () => {
    const blocked = epic({ stage: 'changes', changes: [change('C1', 'awaiting_review'), change('C2', 'ready', ['C1'])] });
    assert.equal(runWouldDoSomething(blocked), false);
    assert.ok(!ids(epicActions(blocked, false)).includes('run'));
    const unblocked = epic({ stage: 'changes', changes: [change('C1', 'merged'), change('C2', 'ready', ['C1'])] });
    assert.equal(epicActions(unblocked, false)[0]?.id, 'run');
  });

  it('routes change actions by status', () => {
    assert.deepEqual(ids(changeActions(change('C1', 'draft'), false)), ['approve', 'revise', 'drop']);
    assert.deepEqual(ids(changeActions(change('C1', 'awaiting_review'), false)), ['approve', 'revise']);
    assert.deepEqual(ids(changeActions(change('C1', 'escalated'), false)), ['revise', 'drop']);
    assert.deepEqual(changeActions(change('C1', 'draft'), true), [], 'nothing while the epic runs');
  });

  it('selects the change that needs a decision and shows the matching tab', () => {
    const e = epic({ stage: 'changes', changes: [change('C1', 'ready'), change('C2', 'awaiting_review'), change('C3', 'draft')] });
    const s = reducer(initialState, { type: 'epics', epics: [e] });
    assert.equal(s.changeId, 'C2');
    assert.equal(currentTab(s), 'review');
    const draft = reducer(s, { type: 'select-change', changeId: 'C3' });
    assert.equal(currentTab(draft), 'change');
  });

  it("shows only the current stage's documents, and lets you go back to finished stages", () => {
    const req = epic({ status: 'awaiting_approval', revision: 1 });
    assert.deepEqual(tabsFor(req, 'requirements', undefined), ['idea', 'requirements', 'history']);
    const changes = epic({ stage: 'changes', changes: [change('C1', 'draft')] });
    let s = reducer(initialState, { type: 'epics', epics: [changes] });
    assert.equal(currentView(s), 'changes');
    assert.deepEqual(tabsFor(changes, 'changes', changes.changes[0]), ['change', 'review', 'history'], 'no idea, requirements or epic spec tabs');

    s = reducer(s, { type: 'view', view: 'requirements' });
    assert.equal(currentView(s), 'requirements');
    assert.equal(currentTab(s), 'requirements');
    s = reducer(s, { type: 'tab', tab: 'change' });
    assert.equal(currentTab(s), 'requirements', 'a tab from another stage falls back to the default');

    const early = reducer(initialState, { type: 'epics', epics: [req] });
    assert.equal(currentView(reducer(early, { type: 'view', view: 'changes' })), 'requirements', 'stages not reached yet stay closed');
    const viewing = reducer(reducer(early, { type: 'view', view: 'requirements' }), { type: 'tab', tab: 'idea' });
    const advanced = reducer(viewing, { type: 'epics', epics: [{ ...req, stage: 'spec', status: 'ready' }] });
    assert.equal(currentView(advanced), 'spec', 'a new stage brings its own documents');
    assert.equal(currentTab(advanced), 'spec');
  });

  it('opens the questions of the stage that asked them', () => {
    const q = { id: 'Q1', text: 't', why: 'w', options: [], round: 1 };
    const e = epic({ stage: 'spec', status: 'awaiting_answers', dialog: { stage: 'spec', rounds: 1, delivered: 0, questions: [q] } });
    const s = reducer(initialState, { type: 'epics', epics: [e] });
    assert.equal(currentTab(s), 'questions');
    assert.deepEqual(tabsFor(e, 'spec', undefined), ['questions', 'spec', 'history']);
    assert.deepEqual(tabsFor(e, 'requirements', undefined), ['idea', 'requirements', 'history'], 'past stage: its dialog is gone');
  });
});

/** A Session over real adapters and a scripted agent, without Electron or the real SDK. */
const fakeSession = (deps: Deps): Session => {
  const running = new Map<string, AbortController>();
  return {
    info: { root: deps.workspaceRoot, name: 'ws', actor: deps.actor, repos: [], warnings: [], tokenEnv: 'GITLAB_TOKEN', gitlabTokenSet: false, canStoreToken: false },
    deps,
    busy: () => [...running.keys()],
    exclusive: async (slug, work) => {
      if (running.has(slug)) return { ok: false, error: `"${slug}" is already running.` };
      running.set(slug, new AbortController());
      try {
        return ok(await work(deps));
      } finally {
        running.delete(slug);
      }
    },
    stop: (slug) => running.get(slug)?.abort(),
    close: () => {},
  };
};

describe('desktop IPC handlers', () => {
  const setup = async () => {
    const dir = await tempDir();
    const ws = await makeRepo(dir, 'planning');
    const api = await makeRepo(dir, 'api');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const agent = scriptedAgent([], async (req) => {
      if (stageOf(req) === 'requirements') {
        await gate;
        return { text: REQUIREMENTS.replace('Users need the thing.', '<img src=x onerror="alert(1)"> fine') };
      }
      if (stageOf(req) === 'epic spec') return { text: EPIC_SPEC };
      return undefined;
    });
    const { deps } = await makeDeps({ workspace: ws.repo, worktrees: join(dir, 'wt'), agent, repos: [{ name: 'api', dir: api.repo, checks: [{ name: 'test', run: 'true' }] }] });
    const opened: string[] = [];
    const sess = fakeSession(deps);
    const { dispatch } = createHandlers({
      session: () => sess,
      open: async () => ({ workspace: sess.info }),
      chooseFolder: async () => undefined,
      openExternal: async (url) => void opened.push(url),
      settings: fileSettings(join(dir, 'settings.json'), { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }),
    });
    return { dispatch, release, opened, deps };
  };

  it('validates arguments from the renderer', async () => {
    const { dispatch } = await setup();
    await assert.rejects(dispatch('run', ['../../etc', false]), /Invalid arguments for run/);
    await assert.rejects(dispatch('readDoc', ['ok', 'secrets.md']), /Invalid arguments/);
    await assert.rejects(dispatch('revise', ['ok', null, '']), /Invalid arguments/, 'feedback is required');
  });

  it('runs one action per epic at a time, and blocks edits while it runs', async () => {
    const { dispatch, release } = await setup();
    const created = (await dispatch('createEpic', ['Search', 'Users want search'])) as Outcome;
    assert.ok(created.ok);
    const slug = created.select!;

    const running = dispatch('run', [slug, false]) as Promise<Outcome>;
    await new Promise((r) => setTimeout(r, 50));
    const second = (await dispatch('run', [slug, false])) as Outcome;
    assert.match(second.text, /already running/);
    const write = (await dispatch('writeDoc', [slug, 'idea.md', 'x'])) as Outcome;
    assert.match(write.text, /running/);

    release();
    assert.ok(((await running) as Outcome).ok);
    const view = (await dispatch('readDoc', [slug, 'requirements.md'])) as { content: string; editable: boolean };
    assert.match(view.content, /onerror/, 'raw markdown goes to the renderer, which sanitizes it');
    assert.equal(view.editable, true);
  });

  it('only opens web links externally', async () => {
    const { dispatch, opened } = await setup();
    await dispatch('openExternal', ['https://gitlab.example/mr/1']);
    await assert.rejects(dispatch('openExternal', ['javascript:alert(1)']), /Invalid arguments/);
    await assert.rejects(dispatch('openExternal', ['file:///etc/passwd']), /Invalid arguments/);
    assert.deepEqual(opened, ['https://gitlab.example/mr/1']);
  });

  it('refuses to edit an approved change spec', async () => {
    const { dispatch } = await setup();
    const r = (await dispatch('writeChangeSpec', ['nope', 'C1', 'x'])) as Outcome;
    assert.equal(r.ok, false);
  });
});

describe('desktop settings', () => {
  const keychain = (available: boolean): Keychain => ({
    available: () => available,
    encrypt: (s) => Buffer.from(`enc:${s}`),
    decrypt: (b) => b.toString().replace(/^enc:/, ''),
  });

  it('keeps recent workspaces, newest first, without duplicates', async () => {
    const s = fileSettings(join(await mkdtemp(join(tmpdir(), 'forge-set-')), 'settings.json'), keychain(true));
    await s.addRecent('/a');
    await s.addRecent('/b');
    await s.addRecent('/a');
    assert.deepEqual(await s.recent(), ['/a', '/b']);
  });

  it('stores the token only encrypted, and refuses without a keychain', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'forge-set-')), 'settings.json');
    const s = fileSettings(path, keychain(true));
    assert.ok((await s.setToken('GITLAB_TOKEN', 'glpat-secret')).ok);
    assert.equal(await s.token('GITLAB_TOKEN'), 'glpat-secret');
    assert.doesNotMatch(await readFile(path, 'utf8'), /glpat-secret/, 'never written in plain text');
    assert.equal((await fileSettings(path, keychain(false)).setToken('GITLAB_TOKEN', 'x')).ok, false);
    assert.ok((await s.setToken('GITLAB_TOKEN', null)).ok);
    assert.equal(await s.token('GITLAB_TOKEN'), undefined);
  });
});

describe('shell PATH', () => {
  it('puts the login shell entries first, without duplicates', () => {
    assert.equal(mergePaths('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin'), '/opt/homebrew/bin:/usr/bin:/bin');
  });
});

describe('repo inspection', () => {
  it('parses GitLab and GitHub remotes in every common form', async () => {
    const { parseRemote } = await import('../src/desktop/main/inspect.ts');
    assert.deepEqual(parseRemote('git@gitlab.com:templo/backend.git'), { host: 'gitlab.com', project: 'templo/backend' });
    assert.deepEqual(parseRemote('ssh://git@gitlab.example.com:2222/group/sub/api.git'), { host: 'gitlab.example.com', project: 'group/sub/api' });
    assert.deepEqual(parseRemote('https://gitlab.com/group/web'), { host: 'gitlab.com', project: 'group/web' });
    assert.deepEqual(parseRemote('git@github.com:Templo-Software/templo-backend.git'), { host: 'github.com', project: 'Templo-Software/templo-backend' });
    assert.equal(parseRemote('not a url'), undefined);
  });

  it('suggests project, branch, setup and checks from the folder, and flags a remote on another host', async () => {
    const { inspectFolder } = await import('../src/desktop/main/inspect.ts');
    const dir = await tempDir();
    const ws = await makeRepo(dir, 'planning');
    const api = await makeRepo(dir, 'Templo Backend', {
      'package.json': JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }),
      'package-lock.json': '{}',
    });
    sh(api.repo, 'remote', 'set-url', 'origin', 'git@github.com:Templo-Software/templo-backend.git');
    const guess = await inspectFolder(api.repo, ws.repo, 'https://gitlab.com');
    assert.equal(guess.name, 'templo-backend');
    assert.equal(guess.path, '../Templo Backend');
    assert.equal(guess.project, 'Templo-Software/templo-backend');
    assert.deepEqual(guess.setup, ['npm ci']);
    assert.deepEqual(guess.checks, [{ name: 'test', run: 'npm test' }, { name: 'lint', run: 'npm run lint' }]);
    assert.match(guess.warnings.join(), /remote is on github\.com, but forge opens merge requests on gitlab\.com/);
  });
});

describe('repo settings handlers', () => {
  const withWorkspace = async () => {
    const dir = await tempDir();
    const ws = await makeRepo(dir, 'planning');
    const api = await makeRepo(dir, 'api');
    const { deps } = await makeDeps({ workspace: ws.repo, worktrees: join(dir, 'wt'), agent: scriptedAgent([], async () => undefined), repos: [{ name: 'api', dir: api.repo, checks: [{ name: 'test', run: 'true' }] }] });
    const { writeConfigFiles } = await import('../src/adapters/fs.ts');
    await writeConfigFiles(ws.repo, { config: `repos:\n  api:\n    path: ../api\n    project: g/api\n    checks:\n      - { name: test, run: "true" }\n`, local: '' });
    let current = fakeSession(deps);
    const opened: string[] = [];
    const { dispatch } = createHandlers({
      session: () => current,
      open: async (root) => {
        opened.push(root);
        return { workspace: current.info };
      },
      chooseFolder: async () => undefined,
      openExternal: async () => {},
      settings: fileSettings(join(dir, 's.json'), { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }),
    });
    return { dir, ws, api, deps, dispatch, opened, setSession: (s: Session) => (current = s) };
  };

  it('lists repos, saves an added one, and reopens the workspace', async () => {
    const { dir, ws, dispatch, opened } = await withWorkspace();
    const settings = (await dispatch('repoSettings', [])) as { repos: { name: string; present: boolean; resolved: string }[] };
    assert.deepEqual(settings.repos.map((r) => [r.name, r.present]), [['api', true]]);
    const web = await makeRepo(dir, 'web');
    const edits = [
      { name: 'api', path: '../api', localPath: '', project: 'g/api', baseBranch: 'main', remote: 'origin', setup: [], checks: [{ name: 'test', run: 'true' }], revertCheck: 'test' },
      { name: 'web', path: '../web', localPath: web.repo, project: 'g/web', baseBranch: 'main', remote: 'origin', setup: ['npm ci'], checks: [{ name: 'test', run: 'npm test' }], revertCheck: 'test' },
    ];
    const saved = (await dispatch('saveRepos', [edits, null])) as Outcome;
    assert.ok(saved.ok, saved.text);
    assert.deepEqual(opened, [ws.repo]);
    assert.match(await readFile(join(ws.repo, '.forge', 'config.yaml'), 'utf8'), /web:\n {4}path: \.\.\/web/);
    assert.match(await readFile(join(ws.repo, '.forge', 'local.yaml'), 'utf8'), new RegExp(`path: ${web.repo}`));
  });

  it("refuses to remove a repo that unfinished changes still build in", async () => {
    const { deps, dispatch } = await withWorkspace();
    const { emit } = await import('../src/application/deps.ts');
    await emit(deps, 'ep', [{ type: 'EpicCreated', slug: 'ep', title: 'Ep', owner: 'me' }]);
    await emit(deps, 'ep', [
      { type: 'ChangesDrafted', drafts: [{ id: 'C1', title: 'C1' }], removed: [], full: true, costUsd: 0 },
      { type: 'ChangeSpecApproved', changeId: 'C1', spec: { id: 'C1', title: 'C1', repo: 'api', kind: 'feature', risk: 'low', files: ['a'], dependsOn: [], verification: ['v'], markdown: '' } },
    ]);
    const other = [{ name: 'web', path: '../web', localPath: '', project: 'g/web', baseBranch: 'main', remote: 'origin', setup: [], checks: [{ name: 'test', run: 'true' }], revertCheck: 'test' }];
    const r = (await dispatch('saveRepos', [other, null])) as Outcome;
    assert.match(r.text, /unfinished changes: ep\/C1 \(api\)/);
  });

  it('sets up a new workspace in an empty planning repo, without overwriting an existing one', async () => {
    const { dir, ws, dispatch, opened } = await withWorkspace();
    const fresh = await makeRepo(dir, 'new-planning');
    const edits = [{ name: 'api', path: '../api', localPath: '', project: 'g/api', baseBranch: 'main', remote: 'origin', setup: [], checks: [{ name: 'test', run: 'true' }], revertCheck: 'test' }];
    const created = (await dispatch('saveRepos', [edits, fresh.repo])) as Outcome;
    assert.ok(created.ok, created.text);
    assert.match(created.text, /Created the workspace/);
    assert.ok(opened.includes(fresh.repo));
    assert.match(await readFile(join(fresh.repo, '.gitattributes'), 'utf8'), /events\.jsonl merge=union/);
    assert.match(await readFile(join(fresh.repo, '.gitignore'), 'utf8'), /\.forge\/local\.yaml/);
    const again = (await dispatch('saveRepos', [edits, ws.repo])) as Outcome;
    assert.match(again.text, /already has \.forge\/config\.yaml/);
  });
});
