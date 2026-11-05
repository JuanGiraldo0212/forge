/**
 * Ports: what the application core needs from the outside world.
 * Each port is a record of functions; adapters are factories that return one.
 */
import type { EpicEvent } from '../domain/epic.ts';
import type { Result } from '../domain/result.ts';

export type PortError = { readonly port: string; readonly message: string };

/** Append-only event log per epic. Also the audit trail. */
export type EpicStore = {
  readonly list: () => Promise<readonly string[]>;
  readonly load: (slug: string) => Promise<readonly EpicEvent[]>;
  readonly append: (slug: string, events: readonly EpicEvent[]) => Promise<void>;
};

/** Human-editable epic documents (requirements.md, epic-spec.md, changes/C1.md, ...). */
export type ArtifactStore = {
  readonly read: (slug: string, name: string) => Promise<string | undefined>;
  readonly write: (slug: string, name: string, content: string) => Promise<void>;
  readonly remove: (slug: string, name: string) => Promise<void>;
  /** File names (without directory) inside a sub-directory of the epic, e.g. "changes". */
  readonly list: (slug: string, dir: string) => Promise<readonly string[]>;
  readonly pathOf: (slug: string, name: string) => string;
};

/** Instructions every agent reads: AGENTS.md and learned rule files, for the workspace or one repo. */
export type RepoContext = {
  readonly instructions: () => Promise<string>;
};

export type AgentMode =
  /** Read-only tools. Used for requirements, spec, plan and review. */
  | 'read'
  /** Edit + Bash inside a sandbox limited to the working directory. Used for build. */
  | 'build';

export type AgentRequest = {
  /** The epic this agent works for (its slug). */
  readonly epic: string;
  /** Short tag for progress output, e.g. "spec", "C1", "review C1". */
  readonly label: string;
  /** Aborting stops the agent; the run then fails like any agent error and is handed back to a human. */
  readonly signal?: AbortSignal;
  readonly cwd: string;
  /** Extra directories the agent may read, e.g. every code repo while planning from the workspace. */
  readonly additionalDirectories?: readonly string[];
  /** Absolute paths or globs the agent must not read (forge's own bookkeeping, for example). */
  readonly denyRead?: readonly string[];
  readonly mode: AgentMode;
  readonly model: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly maxTurns: number;
  /** Continue a previous session so the agent keeps its context between check rounds. */
  readonly resume?: string;
  /** When set, the agent must answer with JSON matching this schema. */
  readonly outputSchema?: Record<string, unknown>;
  /**
   * Lets the agent ask the human questions mid-run. Asking ends the run (with the session kept), and the
   * outcome carries the questions; the caller resumes the session with the answers later.
   */
  readonly ask?: { readonly maxPerCall: number };
};

export type AgentQuestion = {
  readonly header?: string;
  readonly question: string;
  readonly why: string;
  readonly options: readonly { readonly label: string; readonly description?: string; readonly recommended?: boolean }[];
  readonly multiSelect?: boolean;
};

export type AgentOutcome = {
  readonly sessionId: string;
  readonly text: string;
  readonly structured?: unknown;
  /**
   * Estimated spend of the whole session so far, as the SDK reports it. For a resumed session this
   * includes earlier runs; use `runCost` to get this run's share.
   */
  readonly sessionCostUsd: number;
  readonly turns: number;
  /** Set when the agent paused to ask; `text` is then not a finished answer. */
  readonly questions?: readonly AgentQuestion[];
};

export type AgentRunner = {
  readonly run: (req: AgentRequest) => Promise<Result<AgentOutcome, PortError & { readonly sessionCostUsd: number }>>;
};

export type Worktree = { readonly path: string; readonly branch: string; readonly created: boolean };

export type Snapshot = { readonly path: string; readonly commit: string };

export type Vcs = {
  readonly fetch: () => Promise<Result<void, PortError>>;
  /**
   * A read-only checkout of `base` (e.g. origin/main) for planning agents, refreshed on every call.
   * Independent of the developer's working copy: no local branches, edits or stale pulls leak into plans.
   */
  readonly snapshot: (base: string) => Promise<Result<Snapshot, PortError>>;
  /** The last snapshot, if one exists, without touching it (used when fetching fails). */
  readonly existingSnapshot: () => Promise<Snapshot | undefined>;
  /** Creates the worktree, or reuses it if the branch already has one. */
  readonly ensureWorktree: (branch: string, base: string) => Promise<Result<Worktree, PortError>>;
  readonly commitAll: (wt: Worktree, message: string) => Promise<Result<string | undefined, PortError>>;
  readonly head: (wt: Worktree) => Promise<Result<string, PortError>>;
  readonly changedFiles: (wt: Worktree, base: string) => Promise<Result<readonly ChangedFile[], PortError>>;
  readonly diff: (wt: Worktree, base: string) => Promise<Result<string, PortError>>;
  /** Puts `files` back to their state on `base` (deleting files that did not exist there). */
  readonly restoreFromBase: (wt: Worktree, base: string, files: readonly ChangedFile[]) => Promise<Result<void, PortError>>;
  /** Drops every uncommitted change in the worktree. */
  readonly discardChanges: (wt: Worktree) => Promise<Result<void, PortError>>;
  readonly push: (wt: Worktree) => Promise<Result<void, PortError>>;
};

export type ChangedFile = {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Original path, for renames. */
  readonly from?: string;
};

export type MergeRequestState = {
  readonly state: 'opened' | 'merged' | 'closed' | 'locked';
  readonly pipeline?: string;
  readonly url: string;
};

export type CodeHost = {
  readonly openMergeRequest: (mr: {
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly title: string;
    readonly description: string;
  }) => Promise<Result<{ readonly iid: number; readonly url: string }, PortError>>;
  readonly getMergeRequest: (iid: number) => Promise<Result<MergeRequestState, PortError>>;
};

export type Check = { readonly name: string; readonly run: string };
export type CheckResult = { readonly name: string; readonly passed: boolean; readonly output: string };

export type CheckRunner = {
  readonly run: (cwd: string, checks: readonly Check[]) => Promise<readonly CheckResult[]>;
};

export type Clock = () => string;
export type Logger = { readonly info: (msg: string) => void; readonly warn: (msg: string) => void };
