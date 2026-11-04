/**
 * Small presentational building blocks.
 */
import type { ReactNode } from 'react';
import type { ChangeState } from '../../../domain/epic.ts';
import type { ActionSpec } from '../model.ts';

export const Button = ({
  kind = 'secondary',
  onClick,
  disabled,
  children,
  title,
  type = 'button',
}: {
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  title?: string;
  type?: 'button' | 'submit';
}) => (
  <button type={type} className={`btn btn-${kind}`} onClick={onClick} disabled={disabled} title={title}>
    {children}
  </button>
);

export const ActionButtons = ({ actions, onAction }: { actions: readonly ActionSpec[]; onAction: (a: ActionSpec) => void }) => (
  <div className="actions">
    {actions.map((a) => (
      <Button key={`${a.id}-${a.changeId ?? ''}`} kind={a.kind} onClick={() => onAction(a)}>
        {a.label}
      </Button>
    ))}
  </div>
);

export const STATUS_LABEL: Readonly<Record<ChangeState['status'], string>> = {
  draft: 'draft',
  revising: 'redrafting',
  ready: 'approved',
  running: 'building',
  escalated: 'needs input',
  awaiting_review: 'code review',
  approved: 'code approved',
  mr_open: 'MR open',
  merged: 'merged',
  dropped: 'dropped',
};

export const statusTone = (s: ChangeState['status']): string =>
  ({
    draft: 'warn',
    revising: 'accent',
    ready: 'neutral',
    running: 'accent',
    escalated: 'bad',
    awaiting_review: 'warn',
    approved: 'good',
    mr_open: 'info',
    merged: 'good',
    dropped: 'muted',
  })[s];

export const StatusPill = ({ status }: { status: ChangeState['status'] }) => (
  <span className={`pill pill-${statusTone(status)}`}>{STATUS_LABEL[status]}</span>
);

export const Chip = ({ children, tone = 'neutral', title }: { children: ReactNode; tone?: string; title?: string }) => (
  <span className={`chip chip-${tone}`} title={title}>
    {children}
  </span>
);

export const Spinner = () => <span className="spinner" aria-label="running" />;

export const initials = (email: string): string => {
  const name = email.split('@')[0] ?? email;
  const parts = name.split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase();
};

export const Avatar = ({ email, mine }: { email: string; mine?: boolean }) => (
  <span className={`avatar${mine ? ' avatar-mine' : ''}`} title={email}>
    {initials(email)}
  </span>
);
