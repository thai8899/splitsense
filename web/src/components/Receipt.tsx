import type { CSSProperties } from 'react';
import type { ItemAssignment, Receipt as ReceiptData } from '../lib/api';
import { initials, penFor, plain } from '../lib/format';

interface ReceiptProps {
  receipt: ReceiptData;
  participants: string[];
  assignments?: ItemAssignment[];
  /** Tip actually being charged (may differ from the printed tip). */
  tipCents?: number;
  /** edit: chips are toggleable. view: chips are read-only. person: only one person's lines are marked. */
  mode: 'edit' | 'view' | 'person';
  person?: string;
  animate?: boolean;
  onToggle?: (itemId: string, participant: string) => void;
}

/**
 * Highlighter style for a line: one pen for a single owner, an even run of
 * pens when the item is shared, nothing when unassigned.
 */
function markerStyle(owners: string[], participants: string[]): CSSProperties | undefined {
  if (owners.length === 0) return undefined;
  if (owners.length === 1) return { ['--pen' as string]: penFor(participants, owners[0]!) };
  const step = 100 / owners.length;
  const stops = owners
    .map((name, i) => `${penFor(participants, name)} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`)
    .join(', ');
  return {
    backgroundImage: `linear-gradient(100deg, ${stops})`,
    backgroundSize: '100% 78%',
    backgroundPosition: '0 70%',
    backgroundRepeat: 'no-repeat',
  };
}

export function Receipt({ receipt, participants, assignments = [], tipCents, mode, person, animate, onToggle }: ReceiptProps) {
  const byItem = new Map(assignments.map((a) => [a.itemId, a]));
  const tip = tipCents ?? receipt.tipCents;
  const grand = receipt.subtotalCents + receipt.taxCents + tip + receipt.serviceFeeCents - receipt.discountCents;

  return (
    <article className="receipt rounded-t-sm px-5 pb-8 pt-6 text-[13px] leading-relaxed sm:px-7" aria-label={`Receipt from ${receipt.merchant}`}>
      <header className="mb-4 text-center">
        <h3 className="text-base font-semibold tracking-wide">{receipt.merchant}</h3>
        {receipt.date && <p className="text-ink-soft">{receipt.date}</p>}
      </header>
      <div className="border-t border-dashed border-rule" />

      <ul className="my-3 space-y-2.5">
        {receipt.items.map((item, index) => {
          const assignment = byItem.get(item.id);
          const owners = assignment?.shares.map((s) => s.participant) ?? [];
          const mine = mode === 'person' && person ? owners.includes(person) : true;
          const visibleOwners = mode === 'person' ? (mine && person ? [person] : []) : owners;
          const style = markerStyle(visibleOwners, participants);
          return (
            <li key={item.id} className={mode === 'person' && !mine ? 'opacity-35' : undefined}>
              <div className="flex items-baseline justify-between gap-4">
                <span
                  className={`box-decoration-clone px-1 ${visibleOwners.length === 1 ? 'marker' : ''} ${style && animate ? 'marker-animate' : ''}`}
                  style={{ ...style, animationDelay: animate ? `${index * 90}ms` : undefined }}
                >
                  {item.quantity > 1 ? `${item.quantity} × ` : ''}
                  {item.name}
                </span>
                <span className="tabular-nums">{plain(item.totalCents)}</span>
              </div>

              {mode === 'edit' && (
                <div className="mt-1.5 flex flex-wrap gap-1.5 pl-1 font-sans" role="group" aria-label={`Who had ${item.name}`}>
                  {participants.map((name) => {
                    const on = owners.includes(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        onClick={() => onToggle?.(item.id, name)}
                        aria-pressed={on}
                        className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                          on ? 'border-ink text-ink' : 'border-rule text-ink-soft hover:border-ink-soft'
                        }`}
                        style={on ? { background: penFor(participants, name) } : undefined}
                      >
                        {name}
                      </button>
                    );
                  })}
                </div>
              )}

              {mode === 'view' && owners.length > 0 && (
                <div className="mt-1 flex gap-1 pl-1 font-sans">
                  {owners.map((name) => (
                    <span
                      key={name}
                      title={name}
                      className="grid size-5 place-items-center rounded-full text-[10px] font-semibold"
                      style={{ background: penFor(participants, name) }}
                    >
                      {initials(name)}
                    </span>
                  ))}
                </div>
              )}

              {mode === 'edit' && assignment?.reason && (
                <p className="mt-1 pl-1 font-sans text-xs text-ink-soft">{assignment.reason}</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="border-t border-dashed border-rule pt-3">
        <Row label="Subtotal" cents={receipt.subtotalCents} />
        {receipt.taxCents > 0 && <Row label="Tax" cents={receipt.taxCents} />}
        {tip > 0 && <Row label={tip !== receipt.tipCents ? 'Tip (added)' : 'Tip'} cents={tip} />}
        {receipt.serviceFeeCents > 0 && <Row label="Service fee" cents={receipt.serviceFeeCents} />}
        {receipt.discountCents > 0 && <Row label="Discount" cents={-receipt.discountCents} />}
        <div className="mt-2 flex justify-between text-base font-semibold">
          <span>Total {receipt.currency}</span>
          <span className="tabular-nums">{plain(grand)}</span>
        </div>
      </div>
    </article>
  );
}

function Row({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span className="tabular-nums">{plain(cents)}</span>
    </div>
  );
}
