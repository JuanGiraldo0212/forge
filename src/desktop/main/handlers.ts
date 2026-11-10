/**
 * IPC handlers: the main-process side of ForgeApi. Every argument from the renderer is validated here;
 * the renderer is treated as untrusted (it renders agent-written text).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readConfigFile, readLocalConfigFile, writeConfigFiles } from '../../adapters/fs.ts';
import { GITLAB_AUTH_MODES } from '../../application/config.ts';
import { applyGitlabAuth, applyRepoEdits, readGitlabBaseUrl, readRepoEdits, type RepoEdit } from '../../application/configEdit.ts';
import { expand, findRepoRoot } from '../../app/compose.ts';
import { initWorkspaceFiles } from '../../app/init.ts';
import { inspectFolder, listDirectory, remoteHostOf } from './inspect.ts';
import { changeDiff } from '../../application/build.ts';
import { changeIssues } from '../../application/changes.ts';
import { loadEpic } from '../../application/deps.ts';
import { describeEvent } from '../../application/render.ts';
import { gateIssues } from '../../application/stages.ts';
import { changeFile, type GatedStage } from '../../domain/epic.ts';
import {
  abandonAction,
  answerAction,
  approveAction,
  chatAction,
  approveAllAction,
  assignAction,
  createEpicAction,
  dropAction,
  loadAll,
  reviseAction,
  runAction,
  sendBackAction,
  syncAction,
  type Outcome,
} from '../../ui/actions.ts';
import type { DocName, DocView, Method, RepoSettings, WorkspaceInfo } from '../shared/api.ts';
import type { Session } from './session.ts';
import type { WorkspaceSettings } from './settings.ts';

export type HandlerContext = {
  readonly session: () => Session | undefined;
  /** Opens (or reopens) a workspace and makes it current. */
  readonly open: (root: string) => Promise<{ readonly workspace: WorkspaceInfo | null; readonly error?: string }>;
  /** Asks the user for a folder: a native dialog locally, a remote folder browser over SSH. */
  readonly chooseFolder: (title: string) => Promise<string | undefined>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly settings: WorkspaceSettings;
};

const slug = z.string().regex(/^[a-z0-9-]{1,64}$/);
const changeId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const text = z.string().max(20_000);
const doc = z.enum(['idea.md', 'requirements.md', 'epic-spec.md']);

const repoEdit = z.object({
  name: z.string().max(64),
  path: z.string().max(4096),
  localPath: z.string().max(4096),
  project: z.string().max(512),
  baseBranch: z.string().max(256),
  remote: z.string().max(256),
  setup: z.array(z.string().max(2000)).max(20),
  checks: z.array(z.object({ name: z.string().max(64), run: z.string().max(2000) })).max(20),
  revertCheck: z.string().max(64),
});

const ARGS = {
  workspace: z.tuple([]),
  chooseWorkspace: z.tuple([]),
  openWorkspace: z.tuple([z.string().min(1).max(4096)]),
  recentWorkspaces: z.tuple([]),
  listEpics: z.tuple([]),
  readDoc: z.tuple([slug, doc]),
  readChangeSpec: z.tuple([slug, changeId]),
  writeDoc: z.tuple([slug, doc, z.string().max(500_000)]),
  writeChangeSpec: z.tuple([slug, changeId, z.string().max(500_000)]),
  diff: z.tuple([slug, changeId]),
  history: z.tuple([slug]),
  createEpic: z.tuple([z.string().trim().min(1).max(200), text]),
  run: z.tuple([slug, z.boolean()]),
  stop: z.tuple([slug]),
  approve: z.tuple([slug, changeId.nullable(), text]),
  approveAll: z.tuple([slug, text]),
  revise: z.tuple([slug, changeId.nullable(), text.min(1)]),
  answer: z.tuple([slug, z.array(z.object({ questionId: z.string().regex(/^Q\d{1,4}$/), text: text.min(1) })).min(1).max(20)]),
  chat: z.tuple([slug, z.union([z.enum(['requirements', 'spec', 'changes']), changeId]), text.trim().min(1)]),
  sendBack: z.tuple([slug, z.enum(['requirements', 'spec']), text.min(1)]),
  drop: z.tuple([slug, changeId, text.min(1)]),
  assign: z.tuple([slug, z.string().trim().min(1).max(200)]),
  abandon: z.tuple([slug, text.min(1)]),
  sync: z.tuple([slug]),
  repoSettings: z.tuple([]),
  inspectRepo: z.tuple([z.string().max(4096).nullable(), z.string().max(4096).nullable()]),
  saveRepos: z.tuple([z.array(repoEdit).max(50), z.string().max(4096).nullable(), z.string().trim().max(2048).nullable().optional()]),
  chooseNewWorkspace: z.tuple([]),
  setGitlabToken: z.tuple([z.string().trim().min(1).max(1000).nullable()]),
  setGitlabAuth: z.tuple([z.enum(GITLAB_AUTH_MODES)]),
  gitlabAccess: z.tuple([]),
  openExternal: z.tuple([z.string().max(2048).regex(/^https?:\/\//i, 'only http(s) links')]),
  busy: z.tuple([]),
  listDirectory: z.tuple([z.string().max(4096).nullable()]),
} satisfies Record<Method, z.ZodTuple>;


const STAGE_OF: Readonly<Partial<Record<DocName, GatedStage>>> = { 'requirements.md': 'requirements', 'epic-spec.md': 'spec' };

const noWorkspace: Outcome = { ok: false, text: 'Open a workspace first.', tone: 'error' };

export const createHandlers = (ctx: HandlerContext) => {
  const session = () => ctx.session();
  const deps = () => session()?.deps;

  /** Mutations on one epic run exclusively: never two actions on the same epic at once. */
  const exclusive = async (s: string, work: Parameters<Session['exclusive']>[1]): Promise<Outcome> => {
    const sess = session();
    if (!sess) return noWorkspace;
    const r = await sess.exclusive(s, work);
    return r.ok ? (r.value as Outcome) : { ok: false, text: r.error, tone: 'error' };
  };

  const editable = (s: string): boolean => !session()?.busy().includes(s);

  const impl: { readonly [M in Method]: (...args: z.infer<(typeof ARGS)[M]>) => Promise<unknown> } = {
    workspace: async () => session()?.info ?? null,
    chooseWorkspace: async () => {
      const folder = await ctx.chooseFolder('Open a forge workspace');
      return folder ? ctx.open(folder) : { workspace: session()?.info ?? null };
    },
    openWorkspace: (root) => ctx.open(root),
    recentWorkspaces: () => ctx.settings.recent(),

    listEpics: async () => {
      const d = deps();
      return d ? loadAll(d) : [];
    },
    readDoc: async (s, name): Promise<DocView> => {
      const d = deps();
      if (!d) return { path: '', content: undefined, issues: [], editable: false, snapshot: false };
      const epic = await loadEpic(d, s);
      const stage = STAGE_OF[name];
      const content = await d.artifacts.read(s, name);
      const atGate = epic.ok && stage === epic.value.stage && epic.value.status === 'awaiting_approval';
      return {
        path: d.artifacts.pathOf(s, name),
        content,
        issues: atGate && stage && content !== undefined ? await gateIssues(d, s, stage) : [],
        editable: editable(s),
        snapshot: false,
      };
    },
    readChangeSpec: async (s, id): Promise<DocView> => {
      const d = deps();
      const epic = d ? await loadEpic(d, s) : undefined;
      const change = epic?.ok ? epic.value.changes.find((c) => c.id === id) : undefined;
      if (!d || !epic?.ok || !change) return { path: '', content: undefined, issues: [], editable: false, snapshot: false };
      const path = d.artifacts.pathOf(s, changeFile(id));
      if (change.spec) return { path, content: change.spec.markdown, issues: [], editable: false, snapshot: true };
      return {
        path,
        content: await d.artifacts.read(s, changeFile(id)),
        issues: change.status === 'draft' ? await changeIssues(d, epic.value, id) : [],
        editable: change.status === 'draft' && editable(s),
        snapshot: false,
      };
    },
    writeDoc: async (s, name, content) => {
      const d = deps();
      if (!d) return noWorkspace;
      if (!editable(s)) return { ok: false, text: `"${s}" is running; wait for it before editing.`, tone: 'error' };
      if (!(await loadEpic(d, s)).ok) return { ok: false, text: `No epic "${s}".`, tone: 'error' };
      await d.artifacts.write(s, name, content);
      return { ok: true, text: `Saved ${name}.`, tone: 'success' };
    },
    writeChangeSpec: async (s, id, content) => {
      const view = (await impl.readChangeSpec(s, id)) as DocView;
      if (!view.editable) return { ok: false, text: `${id} is not an editable draft.`, tone: 'error' };
      await deps()!.artifacts.write(s, changeFile(id), content);
      return { ok: true, text: `Saved ${id}.`, tone: 'success' };
    },
    diff: async (s, id) => {
      const d = deps();
      if (!d) return '';
      const r = await changeDiff(d, s, id);
      return r.ok ? r.value : r.error.message;
    },
    history: async (s) => {
      const d = deps();
      return d ? (await d.epics.load(s)).map((e) => ({ at: e.at, by: e.by, text: describeEvent(e) })) : [];
    },

    createEpic: async (title, idea) => {
      const d = deps();
      return d ? createEpicAction(d, title, idea) : noWorkspace;
    },
    run: (s, force) => exclusive(s, (d) => runAction(d, s, force)),
    stop: async (s) => session()?.stop(s),
    // Approving code pushes and opens an MR, so it runs exclusively like a run.
    approve: (s, id, note) => exclusive(s, (d) => approveAction(d, s, id ?? undefined, note)),
    approveAll: (s, note) => exclusive(s, (d) => approveAllAction(d, s, note)),
    revise: (s, id, note) => exclusive(s, (d) => reviseAction(d, s, id ?? undefined, note)),
    // Answering resumes the agent, so it runs exclusively (and shows as busy) like a run.
    answer: (s, answers) => exclusive(s, (d) => answerAction(d, s, answers)),
    chat: async (s, thread, message) => {
      const sess = session();
      if (!sess) return noWorkspace;
      // While agents work on the epic, the chat still answers; it just can't queue changes.
      if (sess.busy().includes(s))
        return (await chatAction(sess.deps, s, thread, message, 'agents are working on this epic; ask again once they finish')).outcome;
      // Otherwise hold the epic for the reply and any rerun it queued, but answer as soon as the reply is in.
      return new Promise<Outcome>((resolve) => {
        void exclusive(s, async (d) => {
          const { outcome, rerun } = await chatAction(d, s, thread, message);
          resolve(outcome);
          return rerun ? runAction(d, s, false) : outcome;
        }).then(resolve);
      });
    },
    sendBack: (s, to, note) => exclusive(s, (d) => sendBackAction(d, s, to, note)),
    drop: (s, id, note) => exclusive(s, (d) => dropAction(d, s, id, note)),
    assign: (s, owner) => exclusive(s, (d) => assignAction(d, s, owner)),
    abandon: (s, note) => exclusive(s, (d) => abandonAction(d, s, note)),
    sync: (s) => exclusive(s, (d) => syncAction(d, s)),

    repoSettings: async (): Promise<RepoSettings | null> => {
      const sess = session();
      if (!sess) return null;
      const root = sess.info.root;
      const configText = await readConfigFile(root);
      const edits = readRepoEdits(configText, await readLocalConfigFile(root));
      const epics = await loadAll(sess.deps);
      return {
        root,
        gitlabBaseUrl: readGitlabBaseUrl(configText),
        repos: await Promise.all(
          edits.map(async (e) => {
            const resolved = expand(root, e.localPath || e.path);
            const present = existsSync(join(resolved, '.git'));
            return {
              ...e,
              resolved,
              present,
              remoteHost: present ? await remoteHostOf(resolved, e.remote) : '',
              inUse: epics.flatMap((ep) =>
                ep.changes.filter((c) => c.spec?.repo === e.name && c.status !== 'merged' && c.status !== 'dropped').map((c) => `${ep.slug}/${c.id}`),
              ),
            };
          }),
        ),
      };
    },
    inspectRepo: async (path, workspaceRoot) => {
      const folder = path ?? (await ctx.chooseFolder('Choose a code repository'));
      if (!folder) return null;
      const root = workspaceRoot ?? session()?.info.root;
      if (!root) return null;
      return inspectFolder(folder, root);
    },
    saveRepos: async (repos, newWorkspaceRoot, gitlabBaseUrl) => {
      const sess = session();
      const root = newWorkspaceRoot ?? sess?.info.root;
      if (!root) return noWorkspace;
      const creating = newWorkspaceRoot !== null;
      const configText = await readConfigFile(root);
      if (creating && configText !== undefined) return { ok: false, text: `${root} already has .forge/config.yaml; open it instead.`, tone: 'error' };
      if (!creating && sess?.busy().length) return { ok: false, text: 'Agents are running. Change repositories when they finish.', tone: 'error' };

      if (!creating && sess) {
        const kept = new Set(repos.map((r) => r.name));
        const blocked = (await loadAll(sess.deps)).flatMap((ep) =>
          ep.changes.filter((c) => c.spec && !kept.has(c.spec.repo) && c.status !== 'merged' && c.status !== 'dropped').map((c) => `${ep.slug}/${c.id} (${c.spec!.repo})`),
        );
        if (blocked.length) return { ok: false, text: `Can't remove a repo with unfinished changes: ${blocked.join(', ')}. Finish or drop them first.`, tone: 'error' };
      }

      const files = applyRepoEdits(configText, await readLocalConfigFile(root), repos as readonly RepoEdit[], gitlabBaseUrl ?? undefined);
      if (!files.ok) return { ok: false, text: files.error.join(' · '), tone: 'error' };
      if (creating) await initWorkspaceFiles(root, files.value.config);
      await writeConfigFiles(root, files.value);
      const opened = await ctx.open(root);
      if (opened.error) return { ok: false, text: opened.error, tone: 'error' };
      const missing = opened.workspace?.repos.filter((r) => !r.present).map((r) => r.name) ?? [];
      return {
        ok: true,
        text: `${creating ? `Created the workspace in ${root}. Commit .forge/ and AGENTS.md so the team shares it.` : 'Saved repositories.'}${missing.length ? ` No clone found for: ${missing.join(', ')}.` : ''}`,
        tone: missing.length ? 'info' : 'success',
      };
    },
    chooseNewWorkspace: async () => {
      const folder = await ctx.chooseFolder('Choose the planning repo to set up');
      if (!folder) return { root: null };
      const root = await findRepoRoot(folder);
      if (!root.ok) return { root: null, error: 'Pick a git repository (your planning repo). Create one with "git init" first.' };
      if ((await readConfigFile(root.value)) !== undefined) return { root: null, error: `${root.value} is already a forge workspace. Open it instead.` };
      return { root: root.value };
    },

    setGitlabToken: async (token) => {
      const sess = session();
      if (!sess) return noWorkspace;
      const env = sess.info.tokenEnv;
      const saved = await ctx.settings.setToken(env, token);
      if (!saved.ok) return { ok: false, text: saved.error, tone: 'error' };
      if (token) process.env[env] = token;
      else delete process.env[env];
      // The GitLab adapter reads the token when the workspace is composed; reopen to pick it up.
      await ctx.open(sess.info.root);
      return { ok: true, text: token ? 'GitLab token saved in the OS keychain.' : 'GitLab token removed.', tone: 'success' };
    },
    setGitlabAuth: async (auth) => {
      const sess = session();
      if (!sess) return noWorkspace;
      if (sess.busy().length) return { ok: false, text: 'Agents are running. Change how forge signs in to GitLab when they finish.', tone: 'error' };
      const root = sess.info.root;
      const files = applyGitlabAuth(await readConfigFile(root), await readLocalConfigFile(root), auth);
      if (!files.ok) return { ok: false, text: files.error.join(' · '), tone: 'error' };
      await writeConfigFiles(root, files.value);
      const opened = await ctx.open(root);
      if (opened.error) return { ok: false, text: opened.error, tone: 'error' };
      return { ok: true, text: auth === 'glab' ? 'Forge now signs in to GitLab with the glab login.' : 'Forge now signs in to GitLab with a token.', tone: 'success' };
    },
    gitlabAccess: async () => (await session()?.gitlabAccess()) ?? null,
    openExternal: async (url) => {
      // Only web links (MR URLs). Never file:, javascript: or custom schemes.
      if (/^https?:\/\//i.test(url)) await ctx.openExternal(url);
    },
    busy: async () => session()?.busy() ?? [],
    listDirectory: (path) => listDirectory(path),
  };

  /** Validates raw IPC arguments, then dispatches. */
  const dispatch = async (method: Method, args: readonly unknown[]): Promise<unknown> => {
    const parsed = ARGS[method].safeParse(args);
    if (!parsed.success) throw new Error(`Invalid arguments for ${method}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    return (impl[method] as (...a: unknown[]) => Promise<unknown>)(...(parsed.data as unknown[]));
  };

  return { dispatch, impl };
};
