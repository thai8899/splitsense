import type { ShareStatus } from '../lib/api';

const LABELS: Record<ShareStatus, { text: string; tone: string }> = {
  host: { text: 'Paid the bill', tone: 'bg-ink/8 text-ink-soft' },
  awaiting: { text: 'Not paid yet', tone: 'bg-ink/8 text-ink-soft' },
  order_created: { text: 'Checking out', tone: 'bg-pay/10 text-pay' },
  approved: { text: 'Approved', tone: 'bg-pay/10 text-pay' },
  captured: { text: 'Paid', tone: 'bg-good/12 text-good' },
  completed: { text: 'Paid, confirmed by PayPal', tone: 'bg-good/12 text-good' },
  pending: { text: 'Held for review', tone: 'bg-warn/12 text-warn' },
  failed: { text: 'Declined', tone: 'bg-bad/10 text-bad' },
  refunded: { text: 'Refunded', tone: 'bg-ink/8 text-ink-soft' },
};

export function StatusBadge({ status }: { status: ShareStatus }) {
  const { text, tone } = LABELS[status];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{text}</span>;
}
