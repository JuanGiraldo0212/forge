/**
 * Claude Agent SDK adapter.
 *
 * read  mode: Read/Grep/Glob only.
 * build mode: edits + Bash, with Bash inside the SDK sandbox (writes limited to the worktree,
 *             network limited to an allowlist, credential files unreadable) and secrets stripped from env.
 *             Additional directories (other repos' code) are read-only: Edit and Write are denied there.
 * Worktrees are not containers; see README "Isolation" before running on untrusted input.
 */
import { createSdkMcpServer, query, tool, type Options, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { relative } from 'node:path';
import { err, ok } from '../domain/result.ts';
import type { AgentQuestion, AgentRequest, AgentRunner } from '../ports/index.ts';

const READ_TOOLS = ['Read', 'Grep', 'Glob'];
const BUILD_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];

/** Git operations that belong to the harness, not the agent. */
const BUILD_DENY = [
  'Bash(git push:*)',
  'Bash(git commit:*)',
  'Bash(git remote:*)',
  'Bash(git config:*)',
  'Bash(git reset:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
  'Bash(git rebase:*)',
  'Bash(git worktree:*)',
  'WebFetch',
  'WebSearch',
];

const CREDENTIAL_PATHS = ['~/.ssh', '~/.aws', '~/.config/gcloud', '~/.config/glab-cli', '~/.netrc', '~/.git-credentials', '~/.docker'];

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|_KEY)$/i;

/** The agent keeps what it needs to reach the model; everything that looks like a secret is dropped. */
export const agentEnv = (env: NodeJS.ProcessEnv, extraDeny: readonly string[]): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_') || (!SECRET_ENV.test(k) && !extraDeny.includes(k)),
    ),
  );

export type ClaudeAgentOptions = {
  readonly effort: Options['effort'];
  readonly allowedDomains: readonly string[];
  /** Env vars to withhold from agents even if they do not look secret (e.g. the GitLab token var). */
  readonly withheldEnv: readonly string[];
  readonly onStderr?: (line: string) => void;
  /** Explicit Claude Code binary, e.g. outside a packaged app's asar archive. Defaults to the SDK's own. */
  readonly executable?: string;
  /** One line per tool call, for live progress output. */
  readonly onActivity?: (label: string, text: string, epic: string) => void;
};

const clip = (s: string, n = 70): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** Turns an assistant message into short "Edit src/a.ts" style lines. */
export const describeToolCalls = (message: SDKMessage, cwd: string): readonly string[] => {
  if (message.type !== 'assistant') return [];
  return message.message.content.flatMap((block) => {
    if (block.type !== 'tool_use') return [];
    const input = (block.input ?? {}) as Record<string, unknown>;
    const path = typeof input.file_path === 'string' ? relative(cwd, input.file_path) || input.file_path : undefined;
    const arg = path ?? input.command ?? input.pattern ?? input.description ?? '';
    return [clip(`${block.name} ${String(arg)}`)];
  });
};

export const ASK_TOOL = 'mcp__forge__ask_human';

/**
 * The ask_human tool. It only records the questions; a PostToolUse hook then stops the run, so the
 * agent never guesses an answer and the human can reply whenever they are ready.
 */
const askServer = (maxPerCall: number, asked: AgentQuestion[]) =>
  createSdkMcpServer({
    name: 'forge',
    tools: [
      tool(
        'ask_human',
        `Ask the human (the epic owner) up to ${maxPerCall} questions you cannot answer from the code. The run pauses after this call and resumes with their answers, so call it once with every question you need right now, then stop.`,
        {
          questions: z
            .array(
              z.object({
                header: z.string().min(1).max(24).describe('2-3 words naming the topic, shown as a tab, e.g. "Priority shape"'),
                question: z.string().describe('One short sentence ending with a question mark. Put context in "why", not here.'),
                why: z.string().describe('Why it matters: what you would investigate or recommend differently, and what you found that raises it'),
                options: z
                  .array(
                    z.object({
                      label: z.string().min(1).max(60).describe('The choice in 1-6 words, e.g. "Three levels"'),
                      description: z.string().min(1).describe('One line: what this choice means or implies in these repos'),
                      recommended: z.boolean().optional().describe('true on the single option you would pick'),
                    }),
                  )
                  .min(2)
                  .max(4)
                  .describe('2-4 distinct answers. "Something else" and "Let the agent decide" are always offered, so never add options like "Other" or "You decide".'),
                multiSelect: z.boolean().optional().describe('true if several options can apply at once'),
              }),
            )
            .min(1)
            .max(maxPerCall),
        },
        async (args) => {
          asked.push(
            ...args.questions.map((q) => ({
              header: q.header,
              question: q.question,
              why: q.why,
              options: q.options ?? [],
              multiSelect: q.multiSelect,
            })),
          );
          return { content: [{ type: 'text', text: 'Recorded. The run pauses now; you will be resumed with the answers.' }] };
        },
      ),
    ],
  });

export const optionsFor = (req: AgentRequest, opts: ClaudeAgentOptions, abortController: AbortController, asked: AgentQuestion[] = []): Options => {
  const base: Options = {
    abortController,
    pathToClaudeCodeExecutable: opts.executable,
    cwd: req.cwd,
    additionalDirectories: req.additionalDirectories ? [...req.additionalDirectories] : undefined,
    model: req.model,
    effort: opts.effort,
    maxTurns: req.maxTurns,
    resume: req.resume,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemPrompt, excludeDynamicSections: true },
    // Loads the repo's CLAUDE.md and project settings, but not the developer's personal settings.
    settingSources: ['project'],
    // Agents get no MCP servers, plugins or skills from the developer's machine: those leak tools
    // (mail, docs, databases) into the agent and add hundreds of KB of context per turn.
    mcpServers: {},
    strictMcpConfig: true,
    plugins: [],
    skills: [],
    permissionMode: 'dontAsk',
    env: agentEnv(process.env, opts.withheldEnv),
    stderr: opts.onStderr,
    outputFormat: req.outputSchema ? { type: 'json_schema', schema: req.outputSchema } : undefined,
  };
  // Permission rules take absolute paths as "//abs/path".
  const denyRead = (req.denyRead ?? []).map((p) => `Read(/${p.startsWith('/') ? p : `/${p}`})`);
  if (req.mode === 'read' && req.ask)
    return {
      ...base,
      tools: READ_TOOLS,
      allowedTools: [...READ_TOOLS, ASK_TOOL],
      disallowedTools: denyRead,
      mcpServers: { forge: askServer(req.ask.maxPerCall, asked) },
      hooks: { PostToolUse: [{ matcher: ASK_TOOL, hooks: [async () => ({ continue: false, stopReason: 'Waiting for the human to answer.' })] }] },
    };
  if (req.mode === 'read') return { ...base, tools: READ_TOOLS, allowedTools: READ_TOOLS, disallowedTools: denyRead };
  const readOnly = (req.additionalDirectories ?? []).flatMap((d) => [`Edit(/${d}/**)`, `Write(/${d}/**)`]);
  return {
    ...base,
    tools: BUILD_TOOLS,
    allowedTools: BUILD_TOOLS,
    disallowedTools: [...BUILD_DENY, ...denyRead, ...readOnly],
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [...opts.allowedDomains] },
      filesystem: { allowWrite: [req.cwd], denyRead: CREDENTIAL_PATHS },
    },
  };
};

export const claudeAgentRunner = (opts: ClaudeAgentOptions): AgentRunner => ({
  run: async (req) => {
    let result: SDKResultMessage | undefined;
    const asked: AgentQuestion[] = [];
    const abortController = new AbortController();
    if (req.signal?.aborted) return err({ port: 'agent', message: 'stopped by the user', sessionCostUsd: 0 });
    req.signal?.addEventListener('abort', () => abortController.abort(), { once: true });
    try {
      for await (const message of query({ prompt: req.prompt, options: optionsFor(req, opts, abortController, asked) })) {
        if (message.type === 'result') result = message;
        if (opts.onActivity) for (const line of describeToolCalls(message, req.cwd)) opts.onActivity(req.label, line, req.epic);
      }
    } catch (e) {
      const message = abortController.signal.aborted ? 'stopped by the user' : (e as Error).message;
      return err({ port: 'agent', message, sessionCostUsd: result?.total_cost_usd ?? 0 });
    }
    if (!result) return err({ port: 'agent', message: 'agent ended without a result', sessionCostUsd: 0 });
    // A paused run (it asked) is not an error even if the SDK reports the stop oddly.
    if (asked.length > 0)
      return ok({ sessionId: result.session_id, text: '', sessionCostUsd: result.total_cost_usd, turns: result.num_turns, questions: asked });
    if (result.subtype !== 'success' || result.is_error) {
      const reason = result.subtype === 'success' ? result.result : `${result.subtype}: ${result.errors.join('; ')}`;
      return err({ port: 'agent', message: reason, sessionCostUsd: result.total_cost_usd });
    }
    return ok({
      sessionId: result.session_id,
      text: result.result,
      structured: result.structured_output,
      sessionCostUsd: result.total_cost_usd,
      turns: result.num_turns,
    });
  },
});
