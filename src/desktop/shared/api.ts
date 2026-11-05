/**
 * The contract between the renderer (UI) and the main process. Types only: safe to import anywhere.
 * The renderer never touches Node, git, files or agents; it asks the main process through this API.
 */
import type { Epic } from '../../domain/epic.ts';
import type { RepoEdit } from '../../application/configEdit.ts';
import type { Outcome } from '../../ui/actions.ts';
import type { RepoGuess } from '../main/inspect.ts';

export type { Outcome, RepoEdit, RepoGuess };

export type RepoEditView = RepoEdit & {
  /** Where the clone is on this machine (local path, else shared path), absolute. */
  readonly resolved: string;
  readonly present: boolean;
  /** Unfinished changes that build in this repo ("epic/C1"); the repo can't be removed while there are any. */
  readonly inUse: readonly string[];
};

export type RepoSettings = { readonly root: string; readonly repos: readonly RepoEditView[]; readonly gitlabBaseUrl: string };

export type RepoInfo = { readonly name: string; readonly root: string; readonly project: string; readonly present: boolean };

export type WorkspaceInfo = {
  readonly root: string;
  readonly name: string;
  readonly actor: string;
  readonly repos: readonly RepoInfo[];
  readonly warnings: readonly string[];
  readonly tokenEnv: string;
  readonly gitlabTokenSet: boolean;
  /** Whether the OS keychain can store the GitLab token. */
  readonly canStoreToken: boolean;
};

export type DocName = 'idea.md' | 'requirements.md' | 'epic-spec.md';

export type DocView = {
  readonly path: string;
  readonly content: string | undefined;
  /** What blocks approval right now, when the document is at an open gate or is a draft. */
  readonly issues: readonly string[];
  readonly editable: boolean;
  /** Approved change specs are shown from their immutable snapshot. */
  readonly snapshot: boolean;
};

export type HistoryEntry = { readonly at: string; readonly by: string; readonly text: string };

export type ActivityLine = { readonly epic: string; readonly label: string; readonly text: string; readonly at: string };

export type ForgeApi = {
  readonly workspace: () => Promise<WorkspaceInfo | null>;
  readonly chooseWorkspace: () => Promise<{ readonly workspace: WorkspaceInfo | null; readonly error?: string }>;
  readonly openWorkspace: (root: string) => Promise<{ readonly workspace: WorkspaceInfo | null; readonly error?: string }>;
  readonly recentWorkspaces: () => Promise<readonly string[]>;

  readonly listEpics: () => Promise<readonly Epic[]>;
  readonly readDoc: (slug: string, name: DocName) => Promise<DocView>;
  readonly readChangeSpec: (slug: string, changeId: string) => Promise<DocView>;
  readonly writeDoc: (slug: string, name: DocName, content: string) => Promise<Outcome>;
  readonly writeChangeSpec: (slug: string, changeId: string, content: string) => Promise<Outcome>;
  readonly diff: (slug: string, changeId: string) => Promise<string>;
  readonly history: (slug: string) => Promise<readonly HistoryEntry[]>;

  readonly createEpic: (title: string, idea: string) => Promise<Outcome>;
  readonly run: (slug: string, force: boolean) => Promise<Outcome>;
  readonly stop: (slug: string) => Promise<void>;
  readonly approve: (slug: string, changeId: string | null, note: string) => Promise<Outcome>;
  readonly approveAll: (slug: string, note: string) => Promise<Outcome>;
  readonly revise: (slug: string, changeId: string | null, note: string) => Promise<Outcome>;
  /** Answers the agent's questions; when none are left open, the agent resumes right away. */
  readonly answer: (slug: string, answers: readonly { readonly questionId: string; readonly text: string }[]) => Promise<Outcome>;
  readonly sendBack: (slug: string, to: 'requirements' | 'spec', note: string) => Promise<Outcome>;
  readonly drop: (slug: string, changeId: string, note: string) => Promise<Outcome>;
  readonly assign: (slug: string, owner: string) => Promise<Outcome>;
  readonly abandon: (slug: string, note: string) => Promise<Outcome>;
  readonly sync: (slug: string) => Promise<Outcome>;

  readonly repoSettings: () => Promise<RepoSettings | null>;
  /** Suggests settings for a folder; with null, asks the user to pick one. `workspaceRoot` is for a workspace being set up. */
  readonly inspectRepo: (path: string | null, workspaceRoot: string | null) => Promise<RepoGuess | null>;
  /** Saves the full repo list. With `newWorkspaceRoot`, creates the workspace there first. */
  readonly saveRepos: (repos: readonly RepoEdit[], newWorkspaceRoot: string | null) => Promise<Outcome>;
  /** Picks a git repo without .forge/config.yaml to set up as a workspace. */
  readonly chooseNewWorkspace: () => Promise<{ readonly root: string | null; readonly error?: string }>;

  readonly setGitlabToken: (token: string | null) => Promise<Outcome>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly busy: () => Promise<readonly string[]>;

  /** Subscriptions return an unsubscribe function. */
  readonly onActivity: (fn: (line: ActivityLine) => void) => () => void;
  readonly onEpicsChanged: (fn: () => void) => () => void;
  readonly onBusy: (fn: (busy: readonly string[]) => void) => () => void;
};

/** Request/response methods, in the order the preload exposes them. */
export const METHODS = [
  'workspace',
  'chooseWorkspace',
  'openWorkspace',
  'recentWorkspaces',
  'listEpics',
  'readDoc',
  'readChangeSpec',
  'writeDoc',
  'writeChangeSpec',
  'diff',
  'history',
  'createEpic',
  'run',
  'stop',
  'approve',
  'approveAll',
  'revise',
  'answer',
  'sendBack',
  'drop',
  'assign',
  'abandon',
  'sync',
  'repoSettings',
  'inspectRepo',
  'saveRepos',
  'chooseNewWorkspace',
  'setGitlabToken',
  'openExternal',
  'busy',
] as const satisfies readonly (keyof ForgeApi)[];

export type Method = (typeof METHODS)[number];

export const EVENTS = { activity: 'forge:event:activity', epicsChanged: 'forge:event:epics-changed', busy: 'forge:event:busy' } as const;

export const channel = (m: Method): string => `forge:${m}`;
