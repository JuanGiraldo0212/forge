/**
 * Chat with the epic's agents, beside the documents: one thread per stage agent and per change. Questions
 * get answers; when a message asks for a change, the agent queues it as feedback and forge reruns the work.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatEntry, Epic } from '../../../domain/epic.ts';
import type { Outcome } from '../../shared/api.ts';
import { Markdown } from './DocPanel.tsx';
import { Avatar, Spinner } from './ui.tsx';

const LABEL: Readonly<Record<string, string>> = { requirements: 'Requirements', spec: 'Epic spec', changes: 'Change set' };
export const threadLabel = (thread: string): string => LABEL[thread] ?? thread;

const PLACEHOLDER: Readonly<Record<string, string>> = {
  requirements: 'Ask about the requirements, or ask for a change…',
  spec: 'Ask about the epic spec, or ask for a change…',
  changes: 'Ask about the change set, or ask to split, merge or add changes…',
};

const time = (at: string): string => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const Message = ({ m, actor, onOpenUrl }: { m: ChatEntry; actor: string; onOpenUrl: (url: string) => void }) => {
  if (m.role === 'forge') return <div className="chat-note">{m.text}</div>;
  const human = m.role === 'human';
  return (
    <div className={`chat-msg chat-msg-${human ? 'human' : 'agent'}`}>
      <div className="chat-meta">
        {human ? <Avatar email={m.by} mine={m.by === actor} /> : <span className="chat-agent-dot" aria-hidden />}
        <span>{human ? (m.by === actor ? 'You' : m.by) : 'Agent'}</span>
        <span className="muted">{time(m.at)}</span>
      </div>
      <div className="chat-bubble">{human ? <p className="chat-plain">{m.text}</p> : <Markdown md={m.text} onOpenUrl={onOpenUrl} />}</div>
      {m.feedback && (
        <details className="chat-feedback">
          <summary>Queued as feedback</summary>
          <p>{m.feedback}</p>
        </details>
      )}
    </div>
  );
};

export const ChatPanel = ({
  epic,
  threads,
  actor,
  busy,
  onSend,
  onOpenUrl,
  onCollapse,
}: {
  epic: Epic;
  threads: readonly string[];
  actor: string;
  busy: boolean;
  onSend: (thread: string, text: string) => Promise<Outcome>;
  onOpenUrl: (url: string) => void;
  onCollapse: () => void;
}) => {
  const [picked, setPicked] = useState<string | undefined>();
  const thread = picked && threads.includes(picked) ? picked : threads[0];
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  /** The message being answered, shown until the epic reloads with it. */
  const [pending, setPending] = useState<{ readonly thread: string; readonly text: string; readonly count: number } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => setPicked(undefined), [epic.slug]);
  useEffect(() => setError(undefined), [thread]);

  const messages = thread ? (epic.chats[thread] ?? []) : [];
  // The human's message lands in the log first; keep the optimistic copy only until it shows up.
  const echo = pending && pending.thread === thread && messages.length <= pending.count ? pending.text : undefined;

  useLayoutEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [thread, messages.length, Boolean(pending)]);

  if (!thread) return null;
  const draft = drafts[thread] ?? '';
  const waiting = pending?.thread === thread;

  const send = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    setError(undefined);
    setPending({ thread, text, count: messages.length });
    setDrafts((d) => ({ ...d, [thread]: '' }));
    const o = await onSend(thread, text);
    setPending(undefined);
    if (!o.ok) {
      setError(o.text);
      setDrafts((d) => ({ ...d, [thread]: d[thread] || text }));
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <aside className="chat-panel" aria-label="Chat with the agent">
      <header className="chat-head">
        <div className="chat-title">
          <strong>Chat</strong>
          {threads.length > 1 ? (
            <div className="chat-threads" role="tablist">
              {threads.map((t) => (
                <button key={t} role="tab" aria-selected={t === thread} className={`chat-thread${t === thread ? ' active' : ''}`} onClick={() => setPicked(t)}>
                  {threadLabel(t)}
                </button>
              ))}
            </div>
          ) : (
            <span className="muted">{threadLabel(thread)} agent</span>
          )}
        </div>
        <button className="icon-btn" onClick={onCollapse} aria-label="Hide chat" title="Hide chat">
          ⟩
        </button>
      </header>

      <div className="chat-list" ref={list}>
        {messages.length === 0 && !echo && (
          <div className="chat-empty muted">
            <p>Ask the {threadLabel(thread).toLowerCase()} agent anything about its work.</p>
            <p>Ask for a change and it is queued as feedback, and the agent reworks it straight away.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <Message key={i} m={m} actor={actor} onOpenUrl={onOpenUrl} />
        ))}
        {echo && <Message m={{ role: 'human', text: echo, at: new Date().toISOString(), by: actor }} actor={actor} onOpenUrl={onOpenUrl} />}
        {waiting && (
          <div className="chat-typing muted">
            <Spinner /> The agent is reading and thinking…
          </div>
        )}
      </div>

      <div className="chat-compose">
        {error && <div className="chat-error">{error}</div>}
        {busy && !waiting && <div className="chat-hint muted">Agents are working on this epic. You can ask questions; changes wait until they finish.</div>}
        <textarea
          value={draft}
          rows={3}
          placeholder={PLACEHOLDER[thread] ?? `Ask ${thread}'s agent, or ask for rework…`}
          onChange={(e) => setDrafts((d) => ({ ...d, [thread]: e.target.value }))}
          onKeyDown={onKey}
          disabled={waiting}
          aria-label={`Message the ${threadLabel(thread)} agent`}
        />
        <div className="chat-compose-row">
          <span className="muted small">Enter to send · Shift+Enter for a new line</span>
          <button className="btn btn-primary" onClick={() => void send()} disabled={!draft.trim() || Boolean(pending)}>
            Send
          </button>
        </div>
      </div>
    </aside>
  );
};
