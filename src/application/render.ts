/**
 * Text for merge request descriptions and the history view. Pure.
 */
import {
  STAGE_LABEL,
  unresolved,
  type ChangeState,
  type Epic,
  type EpicEvent,
  type FeedbackResponse,
  type Finding,
  type MergeRequestFeedbackItem,
  type RepoSnapshot,
} from '../domain/epic.ts';
import { FORGE_MARK } from '../domain/review.ts';

const snapshotsText = (snaps: readonly RepoSnapshot[] | undefined): string =>
  snaps?.length
    ? ` (${snaps.map((s) => `${s.repo}@${s.commit ? s.commit.slice(0, 8) : 'working copy'}${s.source === 'stale-snapshot' ? ' stale' : ''}`).join(', ')})`
    : '';

const STATUS_LABEL: Readonly<Record<string, string>> = {
  disputed: ' (disputed by the author)',
  needs_input: " (waiting on the owner's decision)",
};

const findingLine = (f: Finding): string =>
  `- **${f.severity}**${f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}: ${f.summary}${STATUS_LABEL[f.status ?? ''] ?? ''}`;

const reviewSummary = (findings: readonly Finding[]): string => {
  const open = findings.filter(unresolved);
  const fixed = findings.filter((f) => f.status === 'fixed').length;
  const fixedLine = fixed ? `\n\n${fixed} finding${fixed > 1 ? 's' : ''} fixed during the automated review.` : '';
  return `${open.length ? open.map(findingLine).join('\n') : 'No findings.'}${fixedLine}`;
};

const stripFrontmatter = (md: string): string => md.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();

/**
 * GitLab runs quick actions (`/merge`, `/approve`, `/assign`…) found at the start of a line in a note or
 * description, as the account that posts it: forge posts with its owner's sign-in. Text from agents, reviewers and
 * CI logs reaches these bodies, so every such line outside a code block is escaped. Markdown renders `\/` as `/`.
 */
export const noQuickActions = (text: string): string => {
  let fence: string | undefined;
  return text
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
      if (marker && (!fence || marker.startsWith(fence))) {
        fence = fence ? undefined : marker;
        return line;
      }
      return fence ? line : line.replace(/^(\s*)\//, '$1\\/');
    })
    .join('\n');
};

export const mergeRequestDescription = (epic: Epic, change: ChangeState): string => noQuickActions(`## ${change.id}: ${change.title}

| | |
|---|---|
| Epic | ${epic.title} (\`${epic.slug}\`), owner ${epic.owner} |
| Change | ${change.id} · ${change.spec?.kind} · risk **${change.spec?.risk}**${change.spec?.dependsOn.length ? ` · after ${change.spec.dependsOn.join(', ')}` : ''} |
| Revert test | ${change.revertTest === 'passed' ? 'passed: tests fail without this change' : 'not required for this kind'} |

${stripFrontmatter(change.spec?.markdown ?? '')}

### Automated review
${reviewSummary(change.findings)}

---
Opened by Forge after human approval. Merging is a human decision.
`);

/** One review finding as an MR comment. Where it points goes in the comment's position, not its text. */
export const findingComment = (f: Finding, commit: string): string =>
  noQuickActions(
    `**${f.severity === 'blocking' ? 'Blocking' : 'Advisory'}**: ${f.summary}${f.detail ? `\n\n${f.detail}` : ''}${f.note ? `\n\n_${f.note}_` : ''}\n\n<sub>Forge automated review of ${commit.slice(0, 8)}</sub>\n${FORGE_MARK}`,
  );

/** After a rework with nothing new to report: clean, or only findings already on the MR still open. */
export const cleanReviewComment = (commit: string, stillOpen = 0): string =>
  `Forge automated review of ${commit.slice(0, 8)}: ${stillOpen ? `no new findings; ${stillOpen} earlier finding${stillOpen > 1 ? 's' : ''} still open.` : 'no findings.'}\n${FORGE_MARK}`;

/** Forge's answer on the MR to one thread or failed pipeline it picked up, once the rework is pushed. */
export const feedbackReply = (item: MergeRequestFeedbackItem, response: FeedbackResponse | undefined, commit: string): string => {
  const short = commit.slice(0, 8);
  const subject = item.kind === 'ci' ? `Pipeline #${item.pipelineId} failed (${item.jobs.map((j) => j.name).join(', ')}). ` : '';
  const body = !response
    ? `Forge pushed ${short} for this; its agent did not say what it changed.`
    : response.outcome === 'fixed'
      ? `Fixed in ${short}: ${response.reply}`
      : response.outcome === 'not_fixing'
        ? `Not changed: ${response.reply}`
        : `Forge asked the epic's owner: ${response.reply}`;
  return noQuickActions(`${subject}${body}\n\n${FORGE_MARK}`);
};

/** Forge's note on the MR when new feedback waits for the owner instead of being worked on. */
export const heldReply = (reason: string): string =>
  noQuickActions(`Forge picked this up but is not changing the MR on its own: ${reason} The epic's owner decides what happens next.\n\n${FORGE_MARK}`);

const outcomeCount = (responses: readonly FeedbackResponse[]): string => {
  const n = (o: FeedbackResponse['outcome']) => responses.filter((r) => r.outcome === o).length;
  return [n('fixed') && `${n('fixed')} fixed`, n('not_fixing') && `${n('not_fixing')} not changed`, n('needs_input') && `${n('needs_input')} for the owner`]
    .filter(Boolean)
    .join(', ');
};

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
    case 'ChangeReviewed': {
      const open = e.findings.filter(unresolved).length;
      const fixed = e.findings.filter((f) => f.status === 'fixed').length;
      return `${e.changeId} reviewed: ${open} open finding${open === 1 ? '' : 's'}${fixed ? `, ${fixed} fixed` : ''}${e.autofixStopped ? ` (automatic fixes stopped: ${e.autofixStopped})` : ''}${e.gateRequired ? ', needs human review' : ', auto-approved by policy'}`;
    }
    case 'ReviewFixRequested': {
      const open = e.findings.filter(unresolved).length;
      return `${e.changeId} review found ${open} to fix: automatic fix round ${e.round} ($${e.costUsd.toFixed(2)})`;
    }
    case 'FindingsAnswered':
      return `${e.changeId} author answered the findings: ${outcomeCount(e.responses)}`;
    case 'FindingDismissed':
      return `dismissed finding ${e.findingId} of ${e.changeId}${e.note ? `: ${e.note}` : ''}`;
    case 'FindingReopened':
      return `reopened finding ${e.findingId} of ${e.changeId}`;
    case 'MergeRequestFeedbackReceived': {
      const what = e.items.map((i) => (i.kind === 'ci' ? `failed pipeline #${i.pipelineId}` : `a thread by ${i.thread.at(-1)?.author ?? '?'}`));
      if (what.length === 0) return `${e.changeId} MR !${e.iid}: ignored ${[...(e.ignoredNotes ?? []), ...(e.ignoredPipelines ?? [])].length} note(s) or pipeline(s)`;
      return `${e.changeId} MR !${e.iid} feedback: ${what.join(', ')}${e.held ? ` — held for the owner: ${e.held}` : ' — reworking'}`;
    }
    case 'MergeRequestFeedbackAnswered':
      return `${e.changeId} agent answered the MR feedback: ${outcomeCount(e.responses)}`;
    case 'MergeRequestFeedbackReplied':
      return `${e.changeId} replied on MR !${e.iid} for ${e.commit.slice(0, 8)}`;
    case 'MergeRequestWatchResumed':
      return `${e.changeId}: MR watched again as it is${e.note ? `: ${e.note}` : ''}`;
    case 'MergeRequestWatchPaused':
      return `${e.changeId} MR has commits forge did not push (${e.headSha.slice(0, 8)}): automatic fixes paused`;
    case 'ChangeApproved':
      return `approved code for ${e.changeId}${e.note ? `: ${e.note}` : ''}`;
    case 'ChangeReworkRequested':
      return `asked to rework ${e.changeId}: ${e.note}`;
    case 'MergeRequestOpened':
      return `${e.changeId} MR !${e.iid} ${e.url}`;
    case 'SpecMergeRequestOpened':
      return `${e.changeId ? `change spec ${e.changeId}` : 'epic spec'} MR !${e.iid} ${e.url}`;
    case 'SpecMergeRequestClosed':
      return `closed the MR of change spec ${e.changeId} (!${e.iid})`;
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
