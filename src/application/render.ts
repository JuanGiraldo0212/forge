/**
 * Plain-text renderers for the CLI and for MR descriptions. Pure.
 */
import { STAGE_LABEL, type ChangeState, type Epic, type EpicEvent, type Finding, type RepoSnapshot } from '../domain/epic.ts';

const snapshotsText = (snaps: readonly RepoSnapshot[] | undefined): string =>
  snaps?.length
    ? ` (${snaps.map((s) => `${s.repo}@${s.commit ? s.commit.slice(0, 8) : 'working copy'}${s.source === 'stale-snapshot' ? ' stale' : ''}`).join(', ')})`
    : '';

const findingLine = (f: Finding): string =>
  `- **${f.severity}**${f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}: ${f.summary}`;

const stripFrontmatter = (md: string): string => md.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();

export const mergeRequestDescription = (epic: Epic, change: ChangeState): string => `## ${change.id}: ${change.title}

| | |
|---|---|
| Epic | ${epic.title} (\`${epic.slug}\`), owner ${epic.owner} |
| Change | ${change.id} · ${change.spec?.kind} · risk **${change.spec?.risk}**${change.spec?.dependsOn.length ? ` · after ${change.spec.dependsOn.join(', ')}` : ''} |
| Revert test | ${change.revertTest === 'passed' ? 'passed: tests fail without this change' : 'not required for this kind'} |

${stripFrontmatter(change.spec?.markdown ?? '')}

### Automated review
${change.findings.length ? change.findings.map(findingLine).join('\n') : 'No findings.'}

---
Opened by Forge after human approval. Merging is a human decision.
`;

const ICON: Readonly<Record<ChangeState['status'], string>> = {
  draft: '?',
  revising: '~',
  ready: '·',
  running: '>',
  escalated: '!',
  awaiting_review: '?',
  approved: '+',
  mr_open: 'MR',
  merged: 'ok',
  dropped: 'x',
};

const nextAction = (e: Epic): string => {
  if (e.stage === 'done') return 'Done. Every change is merged.';
  if (e.stage === 'abandoned') return 'Abandoned.';
  if (e.stage !== 'changes') {
    if (e.status === 'awaiting_approval')
      return `Gate open: review the ${STAGE_LABEL[e.stage]}, then "forge approve ${e.slug}" or "forge revise ${e.slug} -m ..."`;
    if (e.status === 'running') return `The ${STAGE_LABEL[e.stage]} agent is running.`;
    return `Run "forge run ${e.slug}" to start the ${STAGE_LABEL[e.stage]} agent.`;
  }
  const drafts = e.changes.filter((c) => c.status === 'draft').map((c) => c.id);
  const review = e.changes.filter((c) => c.status === 'awaiting_review' || c.status === 'escalated').map((c) => c.id);
  if (drafts.length)
    return `Review change specs ${drafts.join(', ')}: "forge show ${e.slug} --change <id>", then "forge approve ${e.slug} --change <id>" (or no --change for all).`;
  if (review.length) return `Needs you: ${review.join(', ')}. "forge show ${e.slug} --change <id>", then approve or revise.`;
  if (e.changes.some((c) => c.status === 'mr_open')) return `Merge the open MRs, then "forge sync ${e.slug}".`;
  return `Run "forge run ${e.slug}" to draft revisions and build approved changes.`;
};

export const statusText = (e: Epic): string => {
  const header = `${e.title} (${e.slug})  ·  owner ${e.owner}\nStage: ${STAGE_LABEL[e.stage]}${e.stage === 'explore' || e.stage === 'spec' ? ` [${e.status}]` : ''}  ·  revision ${e.revision}  ·  agent cost ~$${e.costUsd.toFixed(2)}`;
  const error = e.lastError ? `\nLast error: ${e.lastError}` : '';
  const feedback = e.pendingFeedback.length ? `\nPending feedback:\n${e.pendingFeedback.map((x) => `  - ${x}`).join('\n')}` : '';
  const changes = e.changes.length
    ? `\nChanges:\n${e.changes
        .map((c) => {
          const repo = c.spec ? `[${c.spec.repo}] ` : '';
          const deps = c.spec?.dependsOn.length ? ` (after ${c.spec.dependsOn.join(', ')})` : '';
          const extra = c.escalation ? `\n        ! ${c.escalation}` : c.mergeRequest ? `\n        ${c.mergeRequest.url}` : '';
          return `  [${ICON[c.status].padStart(2)}] ${c.id.padEnd(4)} ${c.status.padEnd(15)} ${repo}${c.title}${deps}${extra}`;
        })
        .join('\n')}`
    : '';
  return `${header}${error}${feedback}${changes}\n\nNext: ${nextAction(e)}`;
};

export const changeText = (c: ChangeState): string => {
  const spec = c.spec;
  const head = `${c.id}: ${c.title}\nStatus: ${c.status}${spec ? `  ·  ${spec.repo}  ·  ${spec.kind}  ·  risk ${spec.risk}` : ''}${c.branch ? `  ·  branch ${c.branch}` : ''}`;
  const files = spec ? `\nFiles: ${spec.files.join(', ')}${spec.dependsOn.length ? `\nAfter: ${spec.dependsOn.join(', ')}` : ''}` : '';
  const progress = c.branch ? `\nRounds this attempt: ${c.failures.length}${c.revertTest ? `  ·  revert test: ${c.revertTest}` : ''}` : '';
  const escalation = c.escalation ? `\nEscalated: ${c.escalation}` : '';
  const findings = c.branch
    ? `\n\nFindings:\n${c.findings.length ? c.findings.map((f) => `  [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}${f.summary}${f.detail ? `\n      ${f.detail}` : ''}`).join('\n') : '  none'}`
    : '';
  const feedback = [...c.specFeedback.map((x) => `  - (spec) ${x}`), ...c.feedback.map((x) => `  - (code) ${x}`)];
  return `${head}${files}${progress}${escalation}${findings}${feedback.length ? `\n\nYour feedback so far:\n${feedback.join('\n')}` : ''}`;
};

export const describeEvent = (e: EpicEvent): string => {
  switch (e.type) {
    case 'EpicCreated':
      return `created "${e.title}" (owner ${e.owner})`;
    case 'OwnerChanged':
      return `owner is now ${e.owner}`;
    case 'StageStarted':
      return `${STAGE_LABEL[e.stage]} agent started${snapshotsText(e.snapshots)}`;
    case 'ArtifactProduced':
      return `${STAGE_LABEL[e.stage]} ready ($${e.costUsd.toFixed(2)})`;
    case 'StageFailed':
      return `${STAGE_LABEL[e.stage]} failed: ${e.reason}`;
    case 'GateApproved':
      return `approved ${STAGE_LABEL[e.stage]}${e.note ? `: ${e.note}` : ''}`;
    case 'RevisionRequested':
      return `asked to revise ${STAGE_LABEL[e.stage]}: ${e.note}`;
    case 'SentBack':
      return `sent back to ${STAGE_LABEL[e.to]}: ${e.note}`;
    case 'ChangesDrafted':
      return `${e.full ? 'drafted' : 'redrafted'} change specs ${e.drafts.map((d) => d.id).join(', ')}${e.removed.length ? ` (removed ${e.removed.join(', ')})` : ''}${snapshotsText(e.snapshots)} ($${e.costUsd.toFixed(2)})`;
    case 'ChangeSpecApproved':
      return `approved change spec ${e.changeId} [${e.spec.repo}]${e.note ? `: ${e.note}` : ''}`;
    case 'ChangeSpecRevisionRequested':
      return `asked to revise change spec ${e.changeId}: ${e.note}`;
    case 'ChangeDropped':
      return `dropped ${e.changeId}: ${e.note}`;
    case 'ChangeStarted':
      return `${e.changeId} started on ${e.branch}`;
    case 'ChangeRoundFailed':
      return `${e.changeId} round failed: ${e.signature.split('\n')[0]}`;
    case 'ChangeEscalated':
      return `${e.changeId} escalated: ${e.reason}`;
    case 'ChangeImplemented':
      return `${e.changeId} implemented at ${e.commit.slice(0, 8)} (revert test ${e.revertTest})`;
    case 'ChangeReviewed':
      return `${e.changeId} reviewed: ${e.findings.length} findings${e.gateRequired ? ', needs human review' : ', auto-approved by policy'}`;
    case 'ChangeApproved':
      return `approved code for ${e.changeId}${e.note ? `: ${e.note}` : ''}`;
    case 'ChangeReworkRequested':
      return `asked to rework ${e.changeId}: ${e.note}`;
    case 'MergeRequestOpened':
      return `${e.changeId} MR !${e.iid} ${e.url}`;
    case 'ChangeMerged':
      return `${e.changeId} merged`;
    case 'EpicAbandoned':
      return `abandoned: ${e.note}`;
  }
};

export const logText = (events: readonly EpicEvent[]): string =>
  events.map((e) => `${e.at}  ${e.by.padEnd(12)} ${describeEvent(e)}`).join('\n');
