/**
 * Text for merge request descriptions and the history view. Pure.
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

/** One review finding as an MR comment. Where it points goes in the comment's position, not its text. */
export const findingComment = (f: Finding, commit: string): string =>
  `**${f.severity === 'blocking' ? 'Blocking' : 'Advisory'}**: ${f.summary}${f.detail ? `\n\n${f.detail}` : ''}\n\n<sub>Forge automated review of ${commit.slice(0, 8)}</sub>`;

export const cleanReviewComment = (commit: string): string => `Forge automated review of ${commit.slice(0, 8)}: no findings.`;

/** How a chat thread is named to people. */
export const chatLabel = (thread: string): string =>
  thread === 'requirements' ? 'requirements' : thread === 'spec' ? 'epic spec' : thread === 'changes' ? 'change set' : thread;

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
    case 'QuestionsAsked':
      return `${STAGE_LABEL[e.stage]} agent asked ${e.questions.map((q) => `${q.id}: ${q.text}`).join(' · ')} ($${e.costUsd.toFixed(2)})`;
    case 'QuestionAnswered':
      return `answered ${e.questionId}: ${e.answer}`;
    case 'StageFailed':
      return `${STAGE_LABEL[e.stage]} failed: ${e.reason}`;
    case 'GateApproved':
      return `approved ${STAGE_LABEL[e.stage]}${e.note ? `: ${e.note}` : ''}`;
    case 'ChangeSetApproved':
      return `approved the change set; development starts${e.note ? `: ${e.note}` : ''}`;
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
      return `${e.changeId} started on ${e.branch}${e.dependencySnapshots?.length ? `, reading dependencies${snapshotsText(e.dependencySnapshots)}` : ''}`;
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
    case 'ReviewCommentsPosted':
      return `${e.changeId} review posted to MR !${e.iid} (${e.inline} inline, ${e.general} general)`;
    case 'ChangeMerged':
      return `${e.changeId} merged`;
    case 'EpicAbandoned':
      return `abandoned: ${e.note}`;
    case 'ChatMessage': {
      const who = e.role === 'agent' ? `${chatLabel(e.thread)} agent` : e.role === 'forge' ? 'forge' : 'asked';
      const text = e.text.length > 160 ? `${e.text.slice(0, 160)}…` : e.text;
      return `chat (${chatLabel(e.thread)}) ${who}: ${text}${e.feedback ? ' [queued as feedback]' : ''}`;
    }
  }
};
