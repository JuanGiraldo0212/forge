/**
 * Apps started from the Dock or a launcher do not inherit the login shell's PATH, so git, node and npm
 * (needed by checks and agents) can go missing. Read PATH from the user's login shell once at startup.
 */
import { execFile } from 'node:child_process';

const MARK = '__FORGE_PATH__';

export const mergePaths = (current: string | undefined, fromShell: string): string =>
  [...new Set([...fromShell.split(':'), ...(current ?? '').split(':')].filter(Boolean))].join(':');

export const loginShellPath = (shell = process.env.SHELL || '/bin/sh', timeoutMs = 4000): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeout: timeoutMs }, (error, stdout) => {
      const match = stdout?.toString().match(new RegExp(`${MARK}(.*)${MARK}`));
      resolve(error && !match ? undefined : match?.[1]);
    });
  });

export const fixPath = async (): Promise<void> => {
  if (process.platform === 'win32') return;
  const fromShell = await loginShellPath();
  if (fromShell) process.env.PATH = mergePaths(process.env.PATH, fromShell);
};
