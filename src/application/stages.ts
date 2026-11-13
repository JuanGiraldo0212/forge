/**
 * Epic creation, the single-document stages (requirements, epic spec) and their gates.
 */
import { ARTIFACT_FILE, IDEA_FILE, openQuestions, type AskedQuestion, type DocStage, type Epic, type GatedStage, type Question } from '../domain/epic.ts';
import { canAnswer, canSendBack, openGate, runnableStage, type DomainError } from '../domain/lifecycle.ts';
import { runCost } from '../domain/policy.ts';
import { err, ok, type Result } from '../domain/result.ts';
import { lintRequirements, lintSpec } from '../domain/spec.ts';
import { emit, emitAsForge, loadEpic, type Deps } from './deps.ts';
import { planningRequest, preparePlanning, snapshotRecord, type PlanningView } from './planning.ts';
import { continuePrompt, extractMarkdown, requirementsPrompt, specPrompt, type DocInputs } from './prompts.ts';
import { publishEpicSpec } from './specReview.ts';

export { IDEA_FILE };
export const CHANGES_DIR = 'changes';

const slugify = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'epic';

export const createEpic = async (
  deps: Deps,
  title: string,
  idea: string,
  owner: string = deps.actor,
): Promise<Result<string, DomainError>> => {
  const existing = new Set(await deps.epics.list());
  const base = slugify(title);
  const slug = [base, ...Array.from({ length: 50 }, (_, i) => `${base}-${i + 2}`)].find((s) => !existing.has(s));
  if (!slug) return err({ code: 'slug_taken', message: `Too many epics named "${base}".` });
  await deps.artifacts.write(slug, IDEA_FILE, `# ${title}\n\n${idea.trim()}\n`);
  await emit(deps, slug, [{ type: 'EpicCreated', slug, title, owner }]);
  return ok(slug);
};

export const assignOwner = async (deps: Deps, slug: string, owner: string): Promise<Result<string, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  if (!owner.trim()) return err({ code: 'no_owner', message: 'Owner is required.' });
  await emit(deps, slug, [{ type: 'OwnerChanged', owner: owner.trim() }]);
  return ok(owner.trim());
};

export const docInputs = async (deps: Deps, epic: Epic, view: PlanningView, previousFile?: string): Promise<DocInputs> => {
  const read = (name: string) => deps.artifacts.read(epic.slug, name);
  return {
    epic,
    idea: (await read(IDEA_FILE)) ?? '',
    repos: view.repos,
    requirements: await read(ARTIFACT_FILE.requirements),
    spec: await read(ARTIFACT_FILE.spec),
    previous: previousFile ? await read(previousFile) : undefined,
  };
};

/** Problems a human must fix (by revising or editing the file) before the gate can pass. */
export const gateIssues = async (deps: Deps, slug: string, stage: GatedStage): Promise<readonly string[]> => {
  const content = await deps.artifacts.read(slug, ARTIFACT_FILE[stage]);
  if (content === undefined) return [`${ARTIFACT_FILE[stage]} is missing`];
  if (stage === 'requirements') {
    const lint = lintRequirements(content);
    return lint.ok ? [] : lint.error;
  }
  // Every requirement must be covered by a planned change; ids come from the approved requirements.
  const requirements = lintRequirements((await deps.artifacts.read(slug, ARTIFACT_FILE.requirements)) ?? '');
  const lint = lintSpec(content, { requirementIds: requirements.ok ? requirements.value.ids : [], repos: Object.keys(deps.repos) });
  return lint.ok ? [] : lint.error;
};

export type StageRun =
  | { readonly kind: 'artifact'; readonly stage: GatedStage; readonly artifact: string; readonly issues: readonly string[] }
  | { readonly kind: 'questions'; readonly stage: GatedStage; readonly questions: readonly AskedQuestion[] };

/**
 * Runs a single-document stage. Each is a conversation: the agent may pause with questions, and the
 * next run resumes the same session with the owner's answers (and any revision feedback) until it
 * writes the document. With questions turned off for a stage, it runs in one go.
 */
export const runGatedStage = async (deps: Deps, epic: Epic, stage: GatedStage): Promise<Result<StageRun, DomainError>> => {
  const settings = deps.config.questions;
  const interactive = settings[stage];
  const dialog = epic.dialog?.stage === stage ? epic.dialog : undefined;
  const resume = interactive && dialog?.sessionId ? dialog : undefined;
  const roundsLeft = interactive ? Math.max(0, settings.maxRounds - (dialog?.rounds ?? 0)) : 0;
  const answered = dialog?.questions.filter((q) => q.answer) ?? [];
  const toDeliver = resume ? answered.filter((q) => q.round > resume.delivered) : [];

  deps.log.info(`Refreshing repo snapshots for "${epic.slug}"...`);
  const view = await preparePlanning(deps);
  await emitAsForge(deps, epic.slug, [
    { type: 'StageStarted', stage, snapshots: snapshotRecord(view), deliveredRound: resume ? resume.rounds : undefined },
  ]);
  deps.log.info(`${resume ? 'Resuming' : 'Running'} ${stage} agent for "${epic.slug}"...`);

  const inputs = await docInputs(deps, epic, view, ARTIFACT_FILE[stage]);
  const asking = { ...inputs, answered, roundsLeft, maxPerRound: settings.maxPerRound };
  const prompt = resume
    ? continuePrompt(stage, toDeliver, epic.pendingFeedback, roundsLeft, settings.maxPerRound)
    : stage === 'requirements'
      ? requirementsPrompt(asking)
      : specPrompt({ ...asking, maxFilesPerChange: deps.config.changes.maxFilesPerChange });
  const result = await deps.agent.run({
    ...(await planningRequest(deps, view, epic.slug, stage, prompt)),
    resume: resume?.sessionId,
    ask: roundsLeft > 0 ? { maxPerCall: settings.maxPerRound } : undefined,
  });
  const baseline = resume?.sessionCostUsd;

  if (!result.ok) {
    await emitAsForge(deps, epic.slug, [
      { type: 'StageFailed', stage, reason: result.error.message, costUsd: runCost(result.error.sessionCostUsd, baseline) },
    ]);
    return err({ code: 'agent_failed', message: `${stage} agent failed: ${result.error.message}` });
  }
  const costUsd = runCost(result.value.sessionCostUsd, baseline);

  if (result.value.questions?.length) {
    const first = (dialog?.questions.length ?? 0) + 1;
    const questions: Question[] = result.value.questions.map((q, i) => ({
      id: `Q${first + i}`,
      header: q.header,
      text: q.question,
      why: q.why,
      options: q.options,
      multiSelect: q.multiSelect,
    }));
    await emitAsForge(deps, epic.slug, [
      { type: 'QuestionsAsked', stage, questions, sessionId: result.value.sessionId, sessionCostUsd: result.value.sessionCostUsd, costUsd },
    ]);
    return ok({ kind: 'questions', stage, questions: questions.map((q) => ({ ...q, round: (dialog?.rounds ?? 0) + 1 })) });
  }

  await deps.artifacts.write(epic.slug, ARTIFACT_FILE[stage], extractMarkdown(result.value.text));
  await emitAsForge(deps, epic.slug, [
    {
      type: 'ArtifactProduced',
      stage,
      costUsd,
      // Keep the session, so a revision continues the conversation instead of starting over.
      ...(interactive ? { sessionId: result.value.sessionId, sessionCostUsd: result.value.sessionCostUsd } : {}),
    },
  ]);
  if (stage === 'spec') await publishEpicSpec(deps, epic.slug);

  return ok({
    kind: 'artifact',
    stage,
    artifact: deps.artifacts.pathOf(epic.slug, ARTIFACT_FILE[stage]),
    issues: await gateIssues(deps, epic.slug, stage),
  });
};

/** Records the owner's answers. Once every question is answered, the next run resumes the agent. */
export const answerQuestions = async (
  deps: Deps,
  slug: string,
  answers: readonly { readonly questionId: string; readonly text: string }[],
): Promise<Result<{ readonly remaining: readonly string[] }, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  if (answers.length === 0) return err({ code: 'no_answers', message: 'No answers given.' });
  const events = [];
  for (const a of answers) {
    const can = canAnswer(loaded.value, a.questionId);
    if (!can.ok) return can;
    if (!a.text.trim()) return err({ code: 'empty_answer', message: `The answer to ${a.questionId} is empty.` });
    events.push({ type: 'QuestionAnswered' as const, stage: can.value, questionId: a.questionId, answer: a.text.trim() });
  }
  await emit(deps, slug, events);
  const after = await loadEpic(deps, slug);
  return ok({ remaining: after.ok ? openQuestions(after.value).map((q) => q.id) : [] });
};

export const runnable = async (
  deps: Deps,
  slug: string,
  force: boolean,
): Promise<Result<{ readonly epic: Epic; readonly stage: DocStage }, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  // A crashed run leaves the stage "running"; a forced run lets the human restart it.
  const epic: Epic = force && loaded.value.status === 'running' ? { ...loaded.value, status: 'ready' } : loaded.value;
  const stage = runnableStage(epic);
  return stage.ok ? ok({ epic, stage: stage.value }) : stage;
};

export const approveStage = async (deps: Deps, slug: string, note: string | undefined): Promise<Result<GatedStage, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const gate = openGate(loaded.value);
  if (!gate.ok) return gate;
  const issues = await gateIssues(deps, slug, gate.value);
  if (issues.length > 0)
    return err({
      code: 'gate_blocked',
      message: `Cannot approve ${gate.value}:\n${issues.map((i) => `  - ${i}`).join('\n')}\nEdit ${deps.artifacts.pathOf(slug, ARTIFACT_FILE[gate.value])} or revise it.`,
    });
  await emit(deps, slug, [{ type: 'GateApproved', stage: gate.value, note }]);
  // The MR gets the version that was approved, owner's edits included.
  if (gate.value === 'spec') await publishEpicSpec(deps, slug);
  return ok(gate.value);
};

export const reviseStage = async (deps: Deps, slug: string, note: string): Promise<Result<GatedStage, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const gate = openGate(loaded.value);
  if (!gate.ok) return gate;
  await emit(deps, slug, [{ type: 'RevisionRequested', stage: gate.value, note }]);
  return ok(gate.value);
};

export const sendBack = async (deps: Deps, slug: string, to: string, note: string): Promise<Result<GatedStage, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const target = canSendBack(loaded.value, to);
  if (!target.ok) return target;
  // The change specs were derived from what is being reworked; they are regenerated later.
  for (const file of await deps.artifacts.list(slug, CHANGES_DIR)) await deps.artifacts.remove(slug, `${CHANGES_DIR}/${file}`);
  await emit(deps, slug, [{ type: 'SentBack', to: target.value, note }]);
  return ok(target.value);
};

export const abandon = async (deps: Deps, slug: string, note: string): Promise<Result<void, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  await emit(deps, slug, [{ type: 'EpicAbandoned', note }]);
  return ok(undefined);
};
