import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Receipt } from '../components/Receipt';
import { Spinner } from '../components/Spinner';
import { StatusBadge } from '../components/StatusBadge';
import { api, ApiError, tokens, type BillView, type ItemAssignment, type ShareView } from '../lib/api';
import { money, penFor } from '../lib/format';

type TipChoice = { mode: 'receipt' } | { mode: 'percent'; value: number } | { mode: 'amount'; value: number };

function tipChoiceFrom(bill: BillView): TipChoice {
  if (!bill.tipOverride) return { mode: 'receipt' };
  if (bill.tipOverride.mode === 'percent') return { mode: 'percent', value: bill.tipOverride.value };
  return { mode: 'amount', value: bill.tipOverride.valueCents / 100 };
}

export function BillPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token') ?? tokens.get(id) ?? '';
  const [bill, setBill] = useState<BillView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBill(await api.bill(id, token));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this bill.');
    }
  }, [id, token]);

  useEffect(() => {
    if (token) tokens.set(id, token);
    void load();
  }, [id, token, load]);

  if (error) {
    return (
      <div className="mx-auto max-w-lg px-5 py-20">
        <h1 className="text-2xl font-bold">This bill isn’t available</h1>
        <p className="mt-2 text-ink-soft">{error}</p>
        <Link to="/" className="mt-6 inline-block font-semibold text-pay underline underline-offset-4">
          Start a new split
        </Link>
      </div>
    );
  }
  if (!bill) {
    return (
      <div className="flex items-center justify-center gap-3 py-32 text-ink-soft">
        <Spinner /> Loading bill…
      </div>
    );
  }
  return bill.status === 'draft' ? (
    <Review bill={bill} token={token} onChange={setBill} />
  ) : (
    <Dashboard bill={bill} token={token} reload={load} />
  );
}

/* ------------------------------------------------------------------ */
/* Review: the host checks the AI's work before links are created.     */
/* ------------------------------------------------------------------ */

function Review({ bill, token, onChange }: { bill: BillView; token: string; onChange: (b: BillView) => void }) {
  const [instructions, setInstructions] = useState(bill.instructions);
  const [tip, setTip] = useState<TipChoice>(tipChoiceFrom(bill));
  const [busy, setBusy] = useState<null | 'save' | 'ai' | 'finalize'>(null);
  const [error, setError] = useState<string | null>(null);
  const [animate, setAnimate] = useState(true);
  const { split, receipt, participants } = bill;

  useEffect(() => {
    const t = setTimeout(() => setAnimate(false), 1500);
    return () => clearTimeout(t);
  }, []);

  async function run<T>(kind: 'save' | 'ai' | 'finalize', task: () => Promise<T>): Promise<T | undefined> {
    setBusy(kind);
    setError(null);
    try {
      return await task();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function save(assignments: ItemAssignment[], nextTip: TipChoice) {
    const updated = await run('save', () => api.saveAssignments(bill.id, token, assignments, nextTip));
    if (updated) onChange(updated);
  }

  function toggle(itemId: string, participant: string) {
    const assignments = receipt.items.map((item) => {
      const current = bill.assignments.find((a) => a.itemId === item.id) ?? { itemId: item.id, shares: [] };
      if (item.id !== itemId) return current;
      const has = current.shares.some((s) => s.participant === participant);
      const names = has
        ? current.shares.filter((s) => s.participant !== participant).map((s) => s.participant)
        : [...current.shares.map((s) => s.participant), participant];
      // A manual edit resets the item to an even split between the chosen people.
      return { itemId, shares: names.map((name) => ({ participant: name, weight: 1 })), reason: 'Edited by you' };
    });
    void save(assignments, tip);
  }

  async function reallocate() {
    const updated = await run('ai', () => api.reallocate(bill.id, token, instructions));
    if (updated) {
      onChange(updated);
      setTip(tipChoiceFrom(updated));
      setAnimate(true);
      setTimeout(() => setAnimate(false), 1500);
    }
  }

  async function finalize() {
    const updated = await run('finalize', () => api.finalize(bill.id, token));
    if (updated) onChange(updated);
  }

  const notes = bill.notes.map((n) => n.replace(/^\[split\]\s*/, ''));
  const unassigned = split.unassignedItemIds.length;

  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-5 py-10 lg:grid-cols-[minmax(0,26rem)_1fr]">
      <section aria-label="Receipt">
        <p className="mb-3 text-sm text-ink-soft">Tap a name under any line to change who had it.</p>
        <Receipt
          receipt={receipt}
          participants={participants}
          assignments={bill.assignments}
          tipCents={split.tipCents}
          mode="edit"
          animate={animate}
          onToggle={toggle}
        />
      </section>

      <section className="space-y-8">
        <header>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{bill.title}</h1>
          <p className="mt-1 text-ink-soft">
            {participants.length} people, {money(split.grandTotalCents, split.currency)} in total. Check the split, then send the links.
          </p>
        </header>

        {notes.length > 0 && (
          <div className="rounded-md border-l-4 border-warn bg-paper p-4">
            <p className="font-semibold">Worth a look</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-soft">
              {notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        )}

        <ul className="divide-y divide-rule border-y border-rule">
          {split.people.map((person) => (
            <li key={person.participant} className="flex items-center gap-4 py-3">
              <span className="size-3 shrink-0 rounded-full" style={{ background: penFor(participants, person.participant) }} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {person.participant}
                  {person.participant === bill.hostName && <span className="font-normal text-ink-soft"> (you)</span>}
                </p>
                <p className="truncate text-sm text-ink-soft">
                  {person.items.length === 0 ? 'Nothing assigned' : person.items.map((i) => i.name).join(', ')}
                </p>
              </div>
              <span className="text-lg font-semibold tabular-nums">{money(person.totalCents, split.currency)}</span>
            </li>
          ))}
        </ul>

        <fieldset className="space-y-2">
          <legend className="font-semibold">Tip</legend>
          <div className="flex flex-wrap items-center gap-2">
            {[
              { label: receipt.tipCents > 0 ? 'As printed' : 'No tip', choice: { mode: 'receipt' } as TipChoice },
              { label: '15%', choice: { mode: 'percent', value: 15 } as TipChoice },
              { label: '18%', choice: { mode: 'percent', value: 18 } as TipChoice },
              { label: '20%', choice: { mode: 'percent', value: 20 } as TipChoice },
            ].map(({ label, choice }) => {
              const active = JSON.stringify(choice) === JSON.stringify(tip);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={active}
                  disabled={busy !== null}
                  onClick={() => {
                    setTip(choice);
                    void save(bill.assignments, choice);
                  }}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium ${active ? 'border-ink bg-ink text-paper' : 'border-rule bg-paper hover:border-ink-soft'}`}
                >
                  {label}
                </button>
              );
            })}
            <span className="text-sm text-ink-soft">
              {money(split.tipCents, split.currency)} shared in proportion to what each person ordered
            </span>
          </div>
        </fieldset>

        <div className="space-y-2">
          <label htmlFor="redo" className="font-semibold">
            Describe it differently
          </label>
          <textarea
            id="redo"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
            maxLength={2000}
            className="w-full rounded-md border border-rule bg-paper px-3 py-2.5"
          />
          <button
            type="button"
            onClick={reallocate}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-md border border-ink px-4 py-2 font-semibold hover:bg-ink hover:text-paper disabled:opacity-60"
          >
            {busy === 'ai' && <Spinner />}
            {busy === 'ai' ? 'Re-splitting…' : 'Re-split with AI'}
          </button>
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-bad/10 p-3 text-sm text-bad">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-6">
          <button
            type="button"
            onClick={finalize}
            disabled={busy !== null || unassigned > 0}
            className="inline-flex items-center gap-3 rounded-md bg-pay px-6 py-3.5 text-lg font-semibold text-paper hover:bg-pay-deep disabled:opacity-60"
          >
            {busy === 'finalize' && <Spinner />}
            Create payment links
          </button>
          {busy === 'save' && (
            <span className="flex items-center gap-2 text-sm text-ink-soft">
              <Spinner /> Saving…
            </span>
          )}
          {unassigned > 0 && <span className="text-sm text-bad">Give every line at least one person first.</span>}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard: live payment tracking after links are sent.              */
/* ------------------------------------------------------------------ */

function Dashboard({ bill, token, reload }: { bill: BillView; token: string; reload: () => Promise<void> }) {
  const [live, setLive] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const { progress, split, participants } = bill;

  useEffect(() => {
    const source = new EventSource(`/api/bills/${bill.id}/events?token=${encodeURIComponent(token)}`);
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    const onUpdate = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as { shareId?: string };
      if (data.shareId) {
        setFlash(data.shareId);
        setTimeout(() => setFlash(null), 2500);
      }
      void reload();
    };
    source.addEventListener('share_updated', onUpdate);
    source.addEventListener('bill_updated', onUpdate);
    return () => source.close();
  }, [bill.id, token, reload]);

  const pct = progress.owedCents === 0 ? 100 : Math.round((progress.collectedCents / progress.owedCents) * 100);
  const allPaid = progress.owedCount > 0 && progress.paidCount === progress.owedCount;

  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-5 py-10 lg:grid-cols-[1fr_minmax(0,24rem)]">
      <section>
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{allPaid ? 'Everyone’s paid you back.' : bill.title}</h1>
        <div className="mt-6">
          <div className="flex items-baseline justify-between">
            <p className="text-4xl font-extrabold tabular-nums">
              {money(progress.collectedCents, split.currency)}
              <span className="text-lg font-medium text-ink-soft"> of {money(progress.owedCents, split.currency)} back</span>
            </p>
            <span className={`flex items-center gap-2 text-sm ${live ? 'text-good' : 'text-ink-soft'}`}>
              <span className={`size-2 rounded-full ${live ? 'bg-good' : 'bg-rule'}`} />
              {live ? 'Live' : 'Reconnecting'}
            </span>
          </div>
          <div
            className="mt-3 h-3 overflow-hidden rounded-full bg-paper"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Money collected"
          >
            <div className="h-full rounded-full bg-good transition-[width] duration-700" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            {progress.paidCount} of {progress.owedCount} friends paid.{' '}
            {bill.hostPayPalEmail
              ? `Payments go straight to ${bill.hostPayPalEmail}.`
              : 'Payments collect in the demo merchant account.'}
          </p>
        </div>

        <ul className="mt-8 divide-y divide-rule border-y border-rule">
          {bill.shares.map((share) => (
            <ShareRow
              key={share.id}
              share={share}
              pen={penFor(participants, share.participant)}
              highlight={flash === share.id}
              title={bill.title}
              host={bill.hostName}
            />
          ))}
        </ul>
        <p className="mt-4 text-sm text-ink-soft">
          “Paid” appears the moment PayPal captures the money. “Confirmed by PayPal” appears when PayPal’s signed webhook arrives.
        </p>
      </section>

      <aside>
        <Receipt receipt={bill.receipt} participants={participants} assignments={bill.assignments} tipCents={split.tipCents} mode="view" />
        <Link to="/" className="mt-8 inline-block font-semibold text-pay underline underline-offset-4">
          Split another bill
        </Link>
      </aside>
    </div>
  );
}

function ShareRow({ share, pen, highlight, title, host }: { share: ShareView; pen: string; highlight: boolean; title: string; host: string }) {
  const [copied, setCopied] = useState<'link' | 'message' | null>(null);
  const message = useMemo(
    () => `Hey ${share.participant}! Your share of ${title} comes to ${money(share.amountCents, share.currency)}. You can pay it here: ${share.payUrl}. Thanks! (${host})`,
    [share, title, host],
  );

  async function copy(kind: 'link' | 'message') {
    try {
      await navigator.clipboard.writeText(kind === 'link' ? share.payUrl : message);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      window.prompt('Copy this:', kind === 'link' ? share.payUrl : message);
    }
  }

  async function shareNative() {
    if (navigator.share) {
      await navigator.share({ title, text: message }).catch(() => undefined);
    } else {
      await copy('message');
    }
  }

  return (
    <li className={`flex flex-wrap items-center gap-x-4 gap-y-2 py-4 transition-colors duration-700 ${highlight ? 'bg-good/10' : ''}`}>
      <span className="grid size-9 shrink-0 place-items-center rounded-full font-semibold" style={{ background: pen }}>
        {share.participant.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{share.participant}</p>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={share.status} />
          {share.payerName && share.paid && <span className="text-xs text-ink-soft">via {share.payerName}’s PayPal</span>}
        </div>
      </div>
      <span className="text-lg font-semibold tabular-nums">{money(share.amountCents, share.currency)}</span>
      {share.status !== 'host' && !share.paid && (
        <div className="flex w-full gap-2 sm:w-auto">
          <button type="button" onClick={shareNative} className="rounded-md bg-ink px-3 py-1.5 text-sm font-semibold text-paper hover:bg-ink/90">
            {copied === 'message' ? 'Message copied' : 'Send request'}
          </button>
          <button type="button" onClick={() => copy('link')} className="rounded-md border border-rule bg-paper px-3 py-1.5 text-sm font-medium hover:border-ink-soft">
            {copied === 'link' ? 'Link copied' : 'Copy link'}
          </button>
          <a href={share.payUrl} target="_blank" rel="noreferrer" className="rounded-md px-2 py-1.5 text-sm font-medium text-pay underline underline-offset-4">
            Open
          </a>
        </div>
      )}
    </li>
  );
}
