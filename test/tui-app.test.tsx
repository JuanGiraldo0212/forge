/**
 * Renders the real App against real file adapters and a scripted agent, and drives it with keys.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { render } from 'ink-testing-library';
import type { AgentRequest } from '../src/ports/index.ts';
import { App } from '../src/tui/App.tsx';
import type { ActivityLine } from '../src/tui/state.ts';
import { EPIC_SPEC, makeDeps, makeRepo, scriptedAgent, stageOf, tempDir } from './helpers.ts';

const until = async (frame: () => string | undefined, pattern: RegExp, ms = 5000): Promise<string> => {
  const end = Date.now() + ms;
  for (;;) {
    const f = frame() ?? '';
    if (pattern.test(f)) return f;
    if (Date.now() > end) assert.fail(`timed out waiting for ${pattern}\n--- last frame ---\n${f}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const type = async (stdin: { write: (s: string) => void }, text: string) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const enter = async (stdin: { write: (s: string) => void }) => {
  stdin.write('\r');
  await new Promise((r) => setTimeout(r, 5));
};

describe('tui app', () => {
  it('takes an epic from idea to approved change specs with keys only', async () => {
    const dir = await tempDir();
    const ws = await makeRepo(dir, 'planning');
    const api = await makeRepo(dir, 'api');
    const listeners = new Set<(l: ActivityLine) => void>();
    const calls: AgentRequest[] = [];
    const agent = scriptedAgent(calls, async (req) => {
      listeners.forEach((fn) => fn({ label: req.label, text: 'Read README.md' }));
      if (stageOf(req) === 'explore') return { text: '## Summary\nTiny change.\n## Open questions\n1. none' };
      if (stageOf(req) === 'epic spec') return { text: EPIC_SPEC };
      if (stageOf(req) === 'change specs')
        return {
          structured: {
            changes: ['C1', 'C2'].map((id) => ({
              id,
              title: `Change ${id}`,
              repo: 'api',
              kind: 'chore',
              risk: 'low',
              files: [`${id}.md`],
              dependsOn: [],
              goal: `Goal of ${id}.`,
              behavior: 'b',
              verification: ['v'],
              mustNotBreak: ['m'],
            })),
          },
        };
      return undefined;
    });
    const { deps } = await makeDeps({
      workspace: ws.repo,
      worktrees: join(dir, 'wt'),
      agent,
      repos: [{ name: 'api', dir: api.repo, checks: [{ name: 'test', run: 'true' }] }],
    });
    const subscribe = (fn: (l: ActivityLine) => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    };
    const ui = render(<App deps={deps} workspaceName="planning" subscribe={subscribe} pollMs={100} />);
    try {
      await until(ui.lastFrame, /none yet — press n/);

      await type(ui.stdin, 'n');
      await until(ui.lastFrame, /New epic title:/);
      await type(ui.stdin, 'Add search');
      await enter(ui.stdin);
      await until(ui.lastFrame, /Describe the epic/);
      await type(ui.stdin, 'Users want search.');
      await enter(ui.stdin);
      await until(ui.lastFrame, /Created "add-search" \(owner owner@example\.com\)/);
      assert.match(ui.lastFrame()!, /add-search\s+owner/, 'owner shown in the list');

      await type(ui.stdin, 'r');
      const ran = await until(ui.lastFrame, /explore ready for your review/);
      assert.match(ran, /\[explore\] Read README\.md/, 'agent activity is streamed');
      assert.match(ran, /Gate open/, 'state is already reloaded when the message shows');
      await until(ui.lastFrame, /exploration\.md[\s\S]*Tiny change\./);

      await type(ui.stdin, 'a');
      await enter(ui.stdin);
      await until(ui.lastFrame, /Approved explore/);
      await type(ui.stdin, 'r');
      await until(ui.lastFrame, /epic spec ready for your review/);
      await type(ui.stdin, 'a');
      await enter(ui.stdin);
      await until(ui.lastFrame, /Approved epic spec/);

      // Change specs: drafted, each shown and approved on its own.
      await type(ui.stdin, 'r');
      const drafted = await until(ui.lastFrame, /Drafted C1, C2/);
      assert.match(drafted, /draft\s+C1\s+Change C1/);
      await until(ui.lastFrame, /change spec C1[\s\S]*id: C1[\s\S]*repo: api/);

      await type(ui.stdin, 'a');
      await until(ui.lastFrame, /Approve C1 change spec/);
      await enter(ui.stdin);
      await until(ui.lastFrame, /Approved change spec C1/);
      const after = ui.lastFrame()!;
      assert.match(after, /ready\s+C1\s+\[api\] Change C1/);
      assert.match(after, /draft\s+C2/);

      const events = (await deps.epics.load('add-search')).map((e) => e.type);
      assert.deepEqual(events.slice(-2), ['ChangesDrafted', 'ChangeSpecApproved']);
    } finally {
      ui.unmount();
    }
  });
});
