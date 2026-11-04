import { execFile, spawn } from 'node:child_process';
import type { CheckRunner } from '../ports/index.ts';

export type Exec = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** Runs a program without a shell. Never rejects; inspect `code`. */
export const exec = (file: string, args: readonly string[], cwd: string): Promise<Exec> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() || (error && code !== 0 ? error.message : '') });
    });
  });

const MAX_OUTPUT = 200_000;

/** Runs each check through the shell, sequentially, with combined stdout/stderr. */
export const shellCheckRunner = (timeoutMs = 30 * 60 * 1000): CheckRunner => ({
  run: async (cwd, checks) => {
    const results = [];
    for (const check of checks) {
      const result = await new Promise<{ passed: boolean; output: string }>((resolve) => {
        let output = '';
        const child = spawn('sh', ['-c', check.run], { cwd, env: { ...process.env, CI: 'true' }, timeout: timeoutMs });
        const collect = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-MAX_OUTPUT);
        };
        child.stdout.on('data', collect);
        child.stderr.on('data', collect);
        child.on('error', (e) => resolve({ passed: false, output: `${output}\n${e.message}` }));
        child.on('close', (code, signal) =>
          resolve({ passed: code === 0, output: signal ? `${output}\nkilled by ${signal}` : output }),
        );
      });
      results.push({ name: check.name, ...result });
    }
    return results;
  },
});
