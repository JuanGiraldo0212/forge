/**
 * Development aid, active only when FORGE_DESKTOP_CAPTURE points at a JSON script:
 *   [{ "wait": 800, "js": "document.querySelector('button').click()", "png": "/tmp/shot.png" }, ...]
 * Each step optionally runs JS in the page, waits, and saves a screenshot. The app exits afterwards.
 */
import type { BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const Steps = z.array(z.object({ wait: z.number().default(500), js: z.string().optional(), png: z.string().optional() }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const runCaptureScript = async (window: BrowserWindow, scriptPath: string): Promise<void> => {
  const steps = Steps.parse(JSON.parse(await readFile(scriptPath, 'utf8')));
  window.webContents.on('console-message', (event) => {
    const e = event as unknown as { level: string; message: string };
    if (e.level === 'error' || e.level === 'warning') process.stdout.write(`renderer ${e.level}: ${e.message}\n`);
  });
  window.webContents.on('render-process-gone', (_e, details) => process.stdout.write(`renderer gone: ${details.reason}\n`));
  await new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) resolve();
    else window.webContents.once('did-finish-load', () => resolve());
  });
  for (const step of steps) {
    if (step.js) {
      const result = await window.webContents.executeJavaScript(step.js).catch((e: Error) => `error: ${e.message}`);
      if (result !== undefined) process.stdout.write(`capture js -> ${JSON.stringify(result)}\n`);
    }
    await sleep(step.wait);
    if (step.png) await writeFile(step.png, (await window.webContents.capturePage()).toPNG());
  }
};
