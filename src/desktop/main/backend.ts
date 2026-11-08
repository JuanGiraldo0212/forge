/**
 * The workspace backend: the open session plus the IPC handlers that act on it. The desktop app runs
 * one in-process for local workspaces; the forge server runs the same one on an SSH host, so remote
 * workspaces behave exactly like local ones.
 */
import type { Method, WorkspaceInfo } from '../shared/api.ts';
import { createHandlers } from './handlers.ts';
import { openSession, type Session } from './session.ts';
import type { WorkspaceSettings } from './settings.ts';

export type BackendEvents = {
  readonly epicsChanged: () => void;
  readonly busy: (busy: readonly string[]) => void;
  /** A workspace was opened (or reopened) and is now current. */
  readonly opened: (info: WorkspaceInfo) => void;
};

export type Backend = {
  /** Validates and runs one ForgeApi method. */
  readonly dispatch: (method: Method, args: readonly unknown[]) => Promise<unknown>;
  readonly busy: () => readonly string[];
  readonly close: () => void;
};

export const workspaceBackend = (opts: {
  readonly settings: WorkspaceSettings;
  readonly chooseFolder: (title: string) => Promise<string | undefined>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly events: BackendEvents;
  readonly agentExecutable?: string;
}): Backend => {
  let current: Session | undefined;

  const open = async (root: string): Promise<{ workspace: WorkspaceInfo | null; error?: string }> => {
    if (current?.busy().length) return { workspace: current.info, error: 'Agents are running in this workspace. Stop them before switching.' };
    const next = await openSession(
      root,
      opts.settings,
      { epicsChanged: opts.events.epicsChanged, busy: opts.events.busy },
      { agentExecutable: opts.agentExecutable },
    );
    if (!next.ok) return { workspace: current?.info ?? null, error: next.error };
    current?.close();
    current = next.value;
    await opts.settings.addRecent(current.info.root);
    opts.events.opened(current.info);
    opts.events.epicsChanged();
    return { workspace: current.info };
  };

  const handlers = createHandlers({
    session: () => current,
    open,
    chooseFolder: opts.chooseFolder,
    openExternal: opts.openExternal,
    settings: opts.settings,
  });

  return {
    dispatch: handlers.dispatch,
    busy: () => current?.busy() ?? [],
    close: () => current?.close(),
  };
};
