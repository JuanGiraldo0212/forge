/**
 * Chatting with an epic's agents: one thread per single-document stage, one for the change set, and one
 * per change. Each message is answered by a read-only agent that sees the thread's documents (or the
 * change's spec, findings and diff), the code, and the conversation so far.
 *
 * When the human asks for a change, the agent writes it as feedback, and forge queues it exactly like a
 * revision request from a dialog would. Rerunning the work is the caller's job, so it can hold the epic's
 * lock while the agent works. Approval gates are untouched: chat never approves anything.
 */
import { z } from 'zod';
import { ARTIFACT_FILE, changeFile, stageIndex, type ChangeState, type ChatThread, type Epic, type GatedStage } from '../domain/epic.ts';
import { canRevisePlan, revisionTarget, type DomainError } from '../domain/lifecycle.ts';
import { err, ok, type Result } from '../domain/result.ts';
import type { AgentRequest } from '../ports/index.ts';
import { baseRef, emit, emitAsForge, forgeInternals, instructionsFor, loadEpic, repoFor, type Deps, type EventBody } from './deps.ts';
import { CHAT_SCHEMA, chatPrompt, extractJson, systemPrompt, type ChatInputs, type RepoRef } from './prompts.ts';
import { chatLabel } from './render.ts';
import { IDEA_FILE } from './stages.ts';

/** How much of a change's diff the chat agent gets inline; it can read the worktree for the rest. */
const MAX_DIFF = 40_000;
/** Earlier messages the agent sees. */
const MAX_HISTORY = 40;

const fail = (code: string, message: string): Result<never, DomainError> => err({ code, message });

/** The thread exists once its stage is reached (or, for a change, once the change does). */
export const chatThreadOf = (e: Epic, thread: string): Result<ChatThread, DomainError> => {
  if (thread === 'requirements') return ok(thread);
  if (thread === 'spec' || thread === 'changes')
    return stageIndex(e.stage) >= stageIndex(thread) ? ok(thread) : fail('not_reached', `"${e.slug}" has not reached the ${chatLabel(thread)} yet.`);
  return e.changes.some((c) => c.id === thread) ? ok(thread) : fail('unknown_change', `No change "${thread}" in "${e.slug}".`);
};

export type FeedbackTarget = {
  /** What forge does with the feedback, as the end of "Forge then …". */
  readonly effect: string;
  /** The revision request to record, in the human's name. */
  readonly request: (note: string) => EventBody;
};

const STAGE_EFFECT: Readonly<Record<GatedStage, string>> = {
  requirements: 'regenerates the requirements document with it right away',
  spec: 'rewrites the epic spec with it right away',
};

/** What feedback in this thread would do right now, or why the thread can't take any. */
export const feedbackTarget = (e: Epic, thread: string): Result<FeedbackTarget, DomainError> => {
  if (e.stage === 'done' || e.stage === 'abandoned') return fail('finished', `the epic is ${e.stage === 'done' ? 'done' : 'abandoned'}`);
  if (thread === 'requirements' || thread === 'spec') {
    if (e.stage !== thread) return fail('approved', `the ${chatLabel(thread)} ${stageIndex(e.stage) > stageIndex(thread) ? 'is already approved; send the epic back to change it' : 'has not been reached yet'}`);
    if (e.status === 'running') return fail('running', `the ${chatLabel(thread)} agent is running`);
    if (e.status === 'awaiting_answers') return fail('questions', 'the agent is waiting for answers to its questions; answer them in the Questions tab');
    return ok({ effect: STAGE_EFFECT[thread], request: (note) => ({ type: 'RevisionRequested', stage: thread, note }) });
  }
  if (thread === 'changes') {
    const can = canRevisePlan(e);
    if (!can.ok) return fail(can.error.code, 'plan-level feedback only applies while change specs are being drafted');
    return ok({ effect: 'redrafts the unapproved change specs with it right away', request: (note) => ({ type: 'RevisionRequested', stage: 'changes', note }) });
  }
  const target = revisionTarget(e, thread);
  if (!target.ok) {
    const c = e.changes.find((x) => x.id === thread);
    return fail(target.error.code, c ? `${thread} is ${c.status}, so there is nothing to revise right now` : target.error.message);
  }
  return target.value.kind === 'spec'
    ? ok({ effect: `redrafts ${thread}'s change spec with it right away`, request: (note) => ({ type: 'ChangeSpecRevisionRequested', changeId: thread, note }) })
    : ok({
        effect: `has ${thread}'s build agent rework the code with it right away (then the checks and the review run again)`,
        request: (note) => ({ type: 'ChangeReworkRequested', changeId: thread, note }),
      });
};

type Material = ChatInputs['material'];

/** Where the chat agent runs, which repos it reads, and what it talks about. */
type Workspace = { readonly cwd: string; readonly repos: readonly RepoRef[]; readonly material: Material; readonly subject: string };

/** Repo checkouts the agent may read without refreshing anything: the last planning snapshot, else the clone. */
const readableRepos = async (deps: Deps): Promise<readonly RepoRef[]> =>
  Promise.all(
    Object.values(deps.repos).map(async (r): Promise<RepoRef> => {
      const snap = await r.vcs.existingSnapshot();
      const base = { name: r.name, project: r.config.project, ref: baseRef(r.config) };
      return snap ? { ...base, root: snap.path, source: 'stale-snapshot', commit: snap.commit } : { ...base, root: r.root, source: 'working-copy' };
    }),
  );

const changeSpecText = async (deps: Deps, slug: string, c: ChangeState): Promise<string | undefined> =>
  c.spec?.markdown ?? (await deps.artifacts.read(slug, changeFile(c.id)));

const findingsText = (c: ChangeState): string | undefined =>
  c.findings.length
    ? c.findings.map((f) => `- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : ''}${f.summary}${f.detail ? ` — ${f.detail}` : ''}`).join('\n')
    : undefined;

const workspaceFor = async (deps: Deps, e: Epic, thread: ChatThread): Promise<Workspace> => {
  const read = (name: string) => deps.artifacts.read(e.slug, name);
  if (thread === 'requirements' || thread === 'spec' || thread === 'changes') {
    const repos = await readableRepos(deps);
    const subject = thread === 'requirements' ? 'the requirements document' : thread === 'spec' ? 'the epic spec' : 'the change set (the change specs)';
    const material: Material =
      thread === 'requirements'
        ? [
            { title: 'Idea', body: await read(IDEA_FILE) },
            { title: 'Requirements document (current version)', body: await read(ARTIFACT_FILE.requirements) },
          ]
        : thread === 'spec'
          ? [
              { title: 'Approved requirements', body: await read(ARTIFACT_FILE.requirements) },
              { title: 'Epic spec (current version)', body: await read(ARTIFACT_FILE.spec) },
            ]
          : [
              { title: 'Approved epic spec', body: await read(ARTIFACT_FILE.spec) },
              {
                title: 'Change specs',
                body: (
                  await Promise.all(
                    e.changes.filter((c) => c.status !== 'dropped').map(async (c) => `### ${c.id} (${c.status})\n\n${(await changeSpecText(deps, e.slug, c)) ?? '(missing)'}`),
                  )
                ).join('\n\n'),
              },
            ];
    return { cwd: deps.workspaceRoot, repos, material, subject };
  }

  const c = e.changes.find((x) => x.id === thread)!;
  const repo = c.spec ? repoFor(deps, c.spec.repo) : undefined;
  const others = (await readableRepos(deps)).filter((r) => r.name !== c.spec?.repo);
  let cwd = deps.workspaceRoot;
  let repos: readonly RepoRef[] = await readableRepos(deps);
  let diff: string | undefined;
  if (repo?.ok && c.branch) {
    const wt = await repo.value.vcs.ensureWorktree(c.branch, baseRef(repo.value.config));
    if (wt.ok) {
      cwd = wt.value.path;
      repos = [{ name: repo.value.name, project: repo.value.config.project, root: wt.value.path, ref: c.branch }, ...others];
      const d = await repo.value.vcs.diff(wt.value, baseRef(repo.value.config));
      if (d.ok) diff = d.value.length > MAX_DIFF ? `${d.value.slice(0, MAX_DIFF)}\n[... diff truncated; read the worktree for the rest ...]` : d.value;
    }
  }
  const status = [
    `Status: ${c.status}`,
    c.escalation ? `Escalated: ${c.escalation}` : '',
    c.mergeRequest ? `MR: ${c.mergeRequest.url}` : '',
    c.branch ? `Branch: ${c.branch}${cwd !== deps.workspaceRoot ? ` (worktree at ${cwd})` : ''}` : 'Not built yet.',
  ].filter(Boolean);
  const material: Material = [
    { title: 'Epic spec (context: you own only this change)', body: await read(ARTIFACT_FILE.spec) },
    { title: `Change spec ${c.id}`, body: await changeSpecText(deps, e.slug, c) },
    { title: 'Where it stands', body: status.join('\n') },
    { title: 'Automated review findings', body: findingsText(c) },
    { title: 'Feedback already given on the code', body: c.feedback.length ? c.feedback.map((f) => `- ${f}`).join('\n') : undefined },
    { title: 'Diff against the base branch', body: diff ? `\`\`\`diff\n${diff}\n\`\`\`` : undefined },
  ];
  return { cwd, repos, material, subject: `change ${c.id}${c.spec ? ` (in ${c.spec.repo})` : ''}` };
};

const ReplySchema = z.object({ reply: z.string(), feedback: z.string().optional() });

export type ChatTurn = {
  readonly reply: string;
  /** Set when the message was queued as feedback: what forge does next. The caller reruns the work. */
  readonly queued?: string;
};

/**
 * Records the human's message, has the thread's agent answer it, and queues any change it asked for.
 * `blocked` says why nothing can be changed right now (e.g. agents are running), so the agent only answers.
 */
export const sendChat = async (
  deps: Deps,
  slug: string,
  thread: string,
  message: string,
  opts: { readonly blocked?: string; readonly signal?: AbortSignal } = {},
): Promise<Result<ChatTurn, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const epic = loaded.value;
  const valid = chatThreadOf(epic, thread);
  if (!valid.ok) return valid;
  const text = message.trim();
  if (!text) return fail('empty', 'The message is empty.');

  const history = (epic.chats[thread] ?? []).slice(-MAX_HISTORY);
  await emit(deps, slug, [{ type: 'ChatMessage', thread, role: 'human', text }]);

  const target = opts.blocked ? fail('blocked', opts.blocked) : feedbackTarget(epic, thread);
  const ws = await workspaceFor(deps, epic, valid.value);
  const dirs = ws.repos.map((r) => ({ name: r.name, root: r.root }));
  const request: AgentRequest = {
    epic: slug,
    label: `chat ${thread}`,
    signal: opts.signal,
    cwd: ws.cwd,
    additionalDirectories: ws.repos.map((r) => r.root).filter((root) => root !== ws.cwd),
    denyRead: forgeInternals(deps),
    mode: 'read',
    model: deps.config.models.author,
    systemPrompt: systemPrompt(await instructionsFor(deps, dirs)),
    prompt: chatPrompt({
      epic,
      subject: ws.subject,
      material: ws.material,
      repos: ws.repos,
      history,
      message: text,
      author: deps.actor,
      feedback: target.ok ? { accepted: true, effect: target.value.effect } : { accepted: false, reason: target.error.message },
    }),
    maxTurns: deps.config.loop.maxTurnsPerRound,
    outputSchema: CHAT_SCHEMA,
  };
  const result = await deps.agent.run(request);
  if (!result.ok) {
    await emitAsForge(deps, slug, [
      { type: 'ChatMessage', thread, role: 'forge', text: `The agent could not answer: ${result.error.message}`, costUsd: result.error.sessionCostUsd },
    ]);
    return fail('agent_failed', `The ${chatLabel(thread)} agent could not answer: ${result.error.message}`);
  }

  const parsed = ReplySchema.safeParse(extractJson(result.value.structured, result.value.text));
  const reply = (parsed.success ? parsed.data.reply : result.value.text).trim() || '(no answer)';
  const feedback = parsed.success ? parsed.data.feedback?.trim() : undefined;
  const queue = Boolean(feedback) && target.ok;
  await emitAsForge(deps, slug, [
    { type: 'ChatMessage', thread, role: 'agent', text: reply, ...(queue ? { feedback } : {}), costUsd: result.value.sessionCostUsd },
  ]);
  if (feedback && !target.ok)
    await emitAsForge(deps, slug, [{ type: 'ChatMessage', thread, role: 'forge', text: `Not queued: ${target.error.message}.` }]);
  if (!queue || !target.ok) return ok({ reply });

  await emit(deps, slug, [target.value.request(feedback!)]);
  return ok({ reply, queued: target.value.effect });
};
