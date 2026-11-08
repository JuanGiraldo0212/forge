/**
 * The contract between the renderer (UI) and the main process. Types only: safe to import anywhere.
 * The renderer never touches Node, git, files or agents; it asks the main process through this API.
 */
import type { Epic } from '../../domain/epic.ts';
import type { RepoEdit } from '../../application/configEdit.ts';
import type { Outcome } from '../../ui/actions.ts';
import type { DirListing, RepoGuess } from '../main/inspect.ts';
import type { HostEntry, SshAuthKind } from '../main/settings.ts';

export type { DirListing, HostEntry, Outcome, RepoEdit, RepoGuess, SshAuthKind };

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

/** Where forge runs: in this app, or on an SSH host that the app is connected to. */
export type ConnectionInfo =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly id: string; readonly label: string; readonly home: string };

export type ConnectRequest = {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth: SshAuthKind;
  /** For password auth; empty uses the saved password. */
  readonly password: string;
  readonly rememberPassword: boolean;
  /** For key auth: path to the private key on this machine, and its passphrase if it has one. */
  readonly keyPath: string;
  readonly passphrase: string;
  /** Pass this machine's ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN to agents on the host. */
  readonly forwardClaude: boolean;
  /** A host key fingerprint the user just confirmed. */
  readonly trustFingerprint: string | null;
};

export type ConnectResult =
  | { readonly ok: true; readonly connection: ConnectionInfo }
  | {
      readonly ok: false;
      readonly error: string;
      /** Set when the host key needs the user's decision: unknown (first connection) or changed. */
      readonly hostKey?: { readonly fingerprint: string; readonly changed: boolean };
    };

export type ConnectionChange = { readonly connection: ConnectionInfo; readonly error?: string };

/** The main process asks the UI to pick a folder on the SSH host; answer with folderPicked(id, …). */
export type FolderRequest = { readonly id: number; readonly title: string };


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

  /** Folders inside `path` (null: the home folder) where forge runs, for the remote folder browser. */
  readonly listDirectory: (path: string | null) => Promise<DirListing>;

  readonly connection: () => Promise<ConnectionInfo>;
  readonly savedHosts: () => Promise<readonly HostEntry[]>;
  /** Connects to an SSH host and runs forge there; local workspaces stay as they were. */
  readonly connectRemote: (req: ConnectRequest) => Promise<ConnectResult>;
  /** Closes the SSH connection (stopping agents on the host) and goes back to this machine. */
  readonly disconnectRemote: () => Promise<Outcome>;
  readonly forgetHost: (id: string) => Promise<void>;
  /** Answers a FolderRequest; null when the user cancelled. */
  readonly folderPicked: (id: number, path: string | null) => Promise<void>;

  /** Subscriptions return an unsubscribe function. */
  readonly onEpicsChanged: (fn: () => void) => () => void;
  readonly onBusy: (fn: (busy: readonly string[]) => void) => () => void;
  /** Progress while connecting ("Installing forge on the host…"). */
  readonly onConnectionStatus: (fn: (text: string) => void) => () => void;
  readonly onConnectionChanged: (fn: (change: ConnectionChange) => void) => () => void;
  readonly onPickFolder: (fn: (req: FolderRequest) => void) => () => void;
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
  'listDirectory',
] as const satisfies readonly (keyof ForgeApi)[];

/** Methods about the connection itself; the app's main process answers these, never a remote host. */
export const CONNECTION_METHODS = ['connection', 'savedHosts', 'connectRemote', 'disconnectRemote', 'forgetHost', 'folderPicked'] as const satisfies readonly (keyof ForgeApi)[];

export type Method = (typeof METHODS)[number];
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

export const EVENTS = {
  epicsChanged: 'forge:event:epics-changed',
  busy: 'forge:event:busy',
  connectionStatus: 'forge:event:connection-status',
  connectionChanged: 'forge:event:connection-changed',
  pickFolder: 'forge:event:pick-folder',
} as const;

export const channel = (m: Method | ConnectionMethod): string => `forge:${m}`;
