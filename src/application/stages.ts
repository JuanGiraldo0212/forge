/**
 * Epic creation, the single-document stages (explore, epic spec) and their gates.
 */
import { ARTIFACT_FILE, type DocStage, type Epic, type GatedStage } from '../domain/epic.ts';
import { canSendBack, openGate, runnableStage, type DomainError } from '../domain/lifecycle.ts';
import { err, ok, type Result } from '../domain/result.ts';
import { lintSpec } from '../domain/spec.ts';
import { emit, emitAsForge, loadEpic, type Deps } from './deps.ts';
import { planningRequest, preparePlanning, snapshotRecord, type PlanningView } from './planning.ts';
import { explorePrompt, extractMarkdown, specPrompt, type DocInputs } from './prompts.ts';

export const IDEA_FILE = 'idea.md';
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
    exploration: await read(ARTIFACT_FILE.explore),
    spec: await read(ARTIFACT_FILE.spec),
    previous: previousFile ? await read(previousFile) : undefined,
  };
};

/** Problems a human must fix (by revising or editing the file) before the gate can pass. */
export const gateIssues = async (deps: Deps, slug: string, stage: GatedStage): Promise<readonly string[]> => {
  const content = await deps.artifacts.read(slug, ARTIFACT_FILE[stage]);
  if (content === undefined) return [`${ARTIFACT_FILE[stage]} is missing`];
  if (stage === 'spec') {
    const lint = lintSpec(content);
    return lint.ok ? [] : lint.error;
  }
  return [];
};

export type StageRun = { readonly stage: GatedStage; readonly artifact: string; readonly issues: readonly string[] };

export const runGatedStage = async (deps: Deps, epic: Epic, stage: GatedStage): Promise<Result<StageRun, DomainError>> => {
  deps.log.info(`Refreshing repo snapshots for "${epic.slug}"...`);
  const view = await preparePlanning(deps);
  await emitAsForge(deps, epic.slug, [{ type: 'StageStarted', stage, snapshots: snapshotRecord(view) }]);
  deps.log.info(`Running ${stage} agent for "${epic.slug}"...`);

  const inputs = await docInputs(deps, epic, view, ARTIFACT_FILE[stage]);
  const result = await deps.agent.run(
    await planningRequest(deps, view, epic.slug, stage, stage === 'explore' ? explorePrompt(inputs) : specPrompt(inputs)),
  );

  if (!result.ok) {
    await emitAsForge(deps, epic.slug, [
      { type: 'StageFailed', stage, reason: result.error.message, costUsd: result.error.sessionCostUsd },
    ]);
    return err({ code: 'agent_failed', message: `${stage} agent failed: ${result.error.message}` });
  }

  await deps.artifacts.write(epic.slug, ARTIFACT_FILE[stage], extractMarkdown(result.value.text));
  // Stage agents always start a fresh session, so the session total is this run's spend.
  await emitAsForge(deps, epic.slug, [{ type: 'ArtifactProduced', stage, costUsd: result.value.sessionCostUsd }]);

  return ok({
    stage,
    artifact: deps.artifacts.pathOf(epic.slug, ARTIFACT_FILE[stage]),
    issues: await gateIssues(deps, epic.slug, stage),
  });
};

export const runnable = async (
  deps: Deps,
  slug: string,
  force: boolean,
): Promise<Result<{ readonly epic: Epic; readonly stage: DocStage }, DomainError>> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  // A crashed run leaves the stage "running"; --force lets the human restart it.
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
