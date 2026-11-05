/**
 * The agent's questions, one at a time: a step bar, the question, options as large selectable cards,
 * "Something else" and "Let the agent decide". Sending resumes the paused agent.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { answerText, type AskedQuestion, type Choice, type Epic, type StageDialog } from '../../../domain/epic.ts';
import type { Outcome } from '../../shared/api.ts';
import { Button } from './ui.tsx';

type Draft = Record<string, Choice>;

const isComplete = (c: Choice | undefined): boolean =>
  c !== undefined && (c.kind === 'agent' || (c.kind === 'other' ? c.text.trim().length > 0 : c.labels.length > 0));

const OptionCard = ({
  index,
  label,
  description,
  recommended,
  selected,
  multi,
  onPick,
  children,
}: {
  index: number;
  label: string;
  description?: string;
  recommended?: boolean;
  selected: boolean;
  multi: boolean;
  onPick: () => void;
  children?: React.ReactNode;
}) => (
  <div
    role={multi ? 'checkbox' : 'radio'}
    aria-checked={selected}
    tabIndex={0}
    className={`q-option${selected ? ' selected' : ''}`}
    onClick={onPick}
    onKeyDown={(e) => {
      if (e.key === ' ' && e.target === e.currentTarget) {
        e.preventDefault();
        onPick();
      }
    }}
  >
    <span className="q-option-key">{index}</span>
    <span className={`q-option-mark${multi ? ' multi' : ''}`} aria-hidden>
      {selected ? (multi ? '✓' : '●') : ''}
    </span>
    <span className="q-option-text">
      <span className="q-option-label">
        {label}
        {recommended && <span className="q-recommended">Recommended</span>}
      </span>
      {description && <span className="q-option-desc">{description}</span>}
      {children}
    </span>
  </div>
);

const QuestionCard = ({ q, choice, onChoose }: { q: AskedQuestion; choice: Choice | undefined; onChoose: (c: Choice) => void }) => {
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const multi = Boolean(q.multiSelect);
  const picked = choice?.kind === 'options' ? choice.labels : [];
  const toggle = (label: string) => {
    if (!multi) return onChoose({ kind: 'options', labels: [label] });
    const next = picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label];
    onChoose({ kind: 'options', labels: next });
  };
  const otherIndex = q.options.length + 1;

  useEffect(() => {
    if (choice?.kind === 'other') otherRef.current?.focus();
  }, [choice?.kind]);

  return (
    <div className="q-card-big">
      {q.header && <div className="q-header-chip">{q.header}</div>}
      <h3 className="q-question">{q.text}</h3>
      <p className="q-why">{q.why}</p>
      {multi && <p className="muted small">Pick all that apply.</p>}
      <div className="q-options-list" role={multi ? 'group' : 'radiogroup'} aria-label={q.text}>
        {q.options.map((o, i) => (
          <OptionCard
            key={o.label}
            index={i + 1}
            label={o.label}
            description={o.description}
            recommended={o.recommended}
            selected={picked.includes(o.label)}
            multi={multi}
            onPick={() => toggle(o.label)}
          />
        ))}
        <OptionCard
          index={otherIndex}
          label={q.options.length ? 'Something else' : 'Your answer'}
          description={choice?.kind === 'other' ? undefined : 'Write your own answer.'}
          selected={choice?.kind === 'other'}
          multi={false}
          onPick={() => choice?.kind !== 'other' && onChoose({ kind: 'other', text: '' })}
        >
          {choice?.kind === 'other' && (
            <textarea
              ref={otherRef}
              className="q-other"
              rows={3}
              value={choice.text}
              placeholder="Type your answer"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => onChoose({ kind: 'other', text: e.target.value })}
            />
          )}
        </OptionCard>
        <OptionCard
          index={otherIndex + 1}
          label="Let the agent decide"
          description="It picks, and explains its choice in the document's Decisions."
          selected={choice?.kind === 'agent'}
          multi={false}
          onPick={() => onChoose({ kind: 'agent' })}
        />
      </div>
    </div>
  );
};

const Answered = ({ questions, expanded }: { questions: readonly AskedQuestion[]; expanded: boolean }) => (
  <details className="q-history" open={expanded || questions.length <= 3}>
    <summary>
      Answered <span className="muted">({questions.length})</span>
    </summary>
    <ol>
      {questions.map((q) => (
        <li key={q.id}>
          <span className="muted small">
            {q.id} · round {q.round}
            {q.header ? ` · ${q.header}` : ''}
          </span>
          <div className="q-history-q">{q.text}</div>
          <div className="q-history-a">{q.answer?.text}</div>
        </li>
      ))}
    </ol>
  </details>
);

/** `dialog` is the shown stage's conversation: live (answerable) for the current stage, read-only for an approved one. */
export const QuestionsPanel = ({ epic, dialog, busy, onAnswered }: { epic: Epic; dialog: StageDialog | undefined; busy: boolean; onAnswered: (o: Outcome) => void }) => {
  const questions = dialog?.questions ?? [];
  const open = useMemo(() => questions.filter((q) => !q.answer), [questions]);
  const answered = questions.filter((q) => q.answer);
  const [draft, setDraft] = useState<Draft>({});
  const [step, setStep] = useState(0);
  const [sending, setSending] = useState(false);
  const current = open[Math.min(step, open.length - 1)];
  const done = open.filter((q) => isComplete(draft[q.id])).length;
  const allDone = open.length > 0 && done === open.length;
  const last = step >= open.length - 1;

  const choose = (c: Choice) => current && setDraft((d) => ({ ...d, [current.id]: c }));

  const send = async () => {
    if (!allDone || sending) return;
    setSending(true);
    const outcome = await window.forge.answer(
      epic.slug,
      open.map((q) => ({ questionId: q.id, text: answerText(q, draft[q.id]!) })),
    );
    setSending(false);
    if (outcome.ok) {
      setDraft({});
      setStep(0);
    }
    onAnswered(outcome);
  };

  const next = () => (last ? void send() : setStep((s) => Math.min(s + 1, open.length - 1)));

  // Keyboard: 1-9 pick an option, Enter goes on. Ignored while typing.
  useEffect(() => {
    if (!current || busy) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof Element && e.target.closest('textarea, input, select');
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1) {
        const total = current.options.length + 2;
        if (n > total) return;
        e.preventDefault();
        const c = draft[current.id];
        if (n <= current.options.length) {
          const label = current.options[n - 1]!.label;
          const picked = c?.kind === 'options' ? c.labels : [];
          choose({ kind: 'options', labels: current.multiSelect ? (picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label]) : [label] });
        } else if (n === current.options.length + 1) choose({ kind: 'other', text: c?.kind === 'other' ? c.text : '' });
        else choose({ kind: 'agent' });
      } else if (e.key === 'Enter' && isComplete(draft[current.id])) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (questions.length === 0) return <p className="muted">The agent hasn't asked anything in this stage.</p>;

  return (
    <div className="questions-panel">
      {open.length > 0 && current && (
        <section className="q-wizard" aria-label="Questions from the agent">
          <div className="q-steps">
            {open.map((q, i) => (
              <button key={q.id} className={`q-step${i === step ? ' on' : ''}${isComplete(draft[q.id]) ? ' done' : ''}`} onClick={() => setStep(i)}>
                <span className="q-step-icon">{isComplete(draft[q.id]) ? '✓' : i + 1}</span>
                {q.header ?? q.id}
              </button>
            ))}
            <span className="spacer" />
            <span className="muted small">
              {Math.min(step, open.length - 1) + 1} of {open.length}
            </span>
          </div>
          <QuestionCard key={current.id} q={current} choice={draft[current.id]} onChoose={choose} />
          <div className="q-nav">
            <Button kind="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
              Back
            </Button>
            <span className="muted small">{busy ? 'An agent is running on this epic.' : `1-${current.options.length + 2} to pick · Enter to continue`}</span>
            {last ? (
              <Button kind="primary" onClick={() => void send()} disabled={!allDone || busy || sending}>
                {sending ? 'Sending…' : allDone ? 'Send answers & continue' : `${open.length - done} left to answer`}
              </Button>
            ) : (
              <Button kind="primary" onClick={next} disabled={!isComplete(draft[current.id])}>
                Next
              </Button>
            )}
          </div>
        </section>
      )}
      {answered.length > 0 && <Answered questions={answered} expanded={open.length === 0} />}
    </div>
  );
};
