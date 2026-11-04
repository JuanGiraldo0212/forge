import { render } from 'ink';
import { basename } from 'node:path';
import { composeDeps } from '../cli/compose.ts';
import { App } from './App.tsx';
import type { ActivityLine } from './state.ts';

export const startTui = async (root: string): Promise<void> => {
  const listeners = new Set<(line: ActivityLine) => void>();
  const emitLine = (label: string, text: string) => listeners.forEach((fn) => fn({ label, text }));

  const composed = await composeDeps(root, {
    log: { info: (m) => emitLine('forge', m), warn: (m) => emitLine('warning', m) },
    onActivity: emitLine,
  });
  if (!composed.ok) {
    process.stderr.write(`forge: ${composed.error}\n`);
    process.exit(1);
  }
  const { deps, warnings } = composed.value;

  const subscribe = (fn: (line: ActivityLine) => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  };

  const app = render(<App deps={deps} workspaceName={basename(root)} subscribe={subscribe} warnings={warnings} />, {
    alternateScreen: true,
    exitOnCtrlC: true,
  });
  await app.waitUntilExit();
  // Agents still running belong to this process; leaving stops them (rerun later with R).
  process.exit(0);
};
