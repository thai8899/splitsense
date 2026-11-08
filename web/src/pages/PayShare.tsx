import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PaymentCheckout } from '../components/PaymentCheckout';
import { Spinner } from '../components/Spinner';
import { api, type AppConfig, type PublicShare, type ShareView } from '../lib/api';
import { money, plain } from '../lib/format';

/** The page a friend opens from the link: their lines, their total, one PayPal button. */
export function PayShare() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<PublicShare | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.share(id), api.config()])
      .then(([share, cfg]) => {
        setData(share);
        setConfig(cfg);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'This payment link could not be loaded.'));
  }, [id]);

  if (error) {
    return (
      <Centered>
        <h1 className="text-2xl font-bold">This payment link doesn’t work</h1>
        <p className="mt-2 text-ink-soft">{error} Ask whoever sent it for a new one.</p>
      </Centered>
    );
  }
  if (!data || !config) {
    return (
      <Centered>
        <p className="flex items-center gap-3 text-ink-soft">
          <Spinner /> Loading your share…
        </p>
      </Centered>
    );
  }

  const { share, bill } = data;
  const b = share.breakdown;
  const onPaid = (updated: ShareView) => setData({ share: updated, bill });

  return (
    <div className="mx-auto max-w-xl px-5 py-10 sm:py-16">
      {share.paid ? (
        <PaidView share={share} host={bill.hostName} />
      ) : share.status === 'host' ? (
        <Centered>
          <h1 className="text-2xl font-bold">This is {bill.hostName}’s own share</h1>
          <p className="mt-2 text-ink-soft">They paid the bill, so there’s nothing to pay here.</p>
        </Centered>
      ) : (
        <>
          <p className="text-ink-soft">
            {bill.hostName} paid for {bill.title} at {bill.merchant}.
            {bill.paysHostDirectly && ` Your payment goes straight to ${bill.hostName}'s PayPal.`}
          </p>
          <h1 className="mt-2 text-4xl font-extrabold tracking-tight sm:text-5xl">
            Your share is <span className="tabular-nums">{money(share.amountCents, share.currency)}</span>
          </h1>

          <article className="receipt mt-8 rounded-t-sm px-6 pb-8 pt-6 text-[13px] leading-relaxed" aria-label="Your items">
            <h2 className="mb-3 font-sans text-sm font-semibold">What you had</h2>
            <ul className="space-y-2">
              {b.items.map((line) => (
                <li key={line.itemId} className="flex justify-between gap-4">
                  <span>
                    {line.name}
                    {line.portion !== 'full' && <span className="text-ink-soft"> ({line.portion})</span>}
                  </span>
                  <span className="tabular-nums">{plain(line.amountCents)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 space-y-0.5 border-t border-dashed border-rule pt-3">
              {b.taxCents > 0 && <Line label="Your share of tax" cents={b.taxCents} />}
              {b.tipCents > 0 && <Line label="Your share of tip" cents={b.tipCents} />}
              {b.serviceFeeCents > 0 && <Line label="Your share of fees" cents={b.serviceFeeCents} />}
              {b.discountCents > 0 && <Line label="Your share of discounts" cents={-b.discountCents} />}
              <div className="flex justify-between pt-1 text-base font-semibold">
                <span>You pay</span>
                <span className="tabular-nums">{plain(share.amountCents)}</span>
              </div>
            </div>
            <p className="mt-4 font-sans text-xs text-ink-soft">Tax and tip are split in proportion to what you ordered, rounded so every cent adds up.</p>
          </article>

          {params.get('result') === 'cancelled' && (
            <p className="mt-6 rounded-md bg-ink/5 p-3 text-sm">You left PayPal before paying. Nothing was charged.</p>
          )}

          <div className="mt-8">
            <PaymentCheckout
              clientId={config.paypalClientId}
              shareId={share.id}
              amountCents={share.amountCents}
              currency={share.currency}
              onPaid={onPaid}
            />
          </div>
          {config.environment === 'sandbox' && (
            <p className="mt-4 text-xs text-ink-soft">
              Demo mode: this uses the PayPal Sandbox. Log in with a sandbox personal account. No real money moves.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function PaidView({ share, host }: { share: ShareView; host: string }) {
  return (
    <div className="receipt rounded-t-sm px-7 pb-10 pt-8 text-center font-sans" role="status">
      <div className="mx-auto grid size-14 place-items-center rounded-full bg-good text-2xl text-paper" aria-hidden="true">
        ✓
      </div>
      <h1 className="mt-4 text-3xl font-extrabold tracking-tight">You’re square with {host}.</h1>
      <p className="mt-2 text-lg">
        {money(share.amountCents, share.currency)} paid{share.payerName ? ` from ${share.payerName}’s PayPal` : ''}.
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        {share.status === 'pending'
          ? 'PayPal is reviewing this payment. It usually clears quickly.'
          : `${host} can see it on their dashboard right now.`}
      </p>
      <Link to="/" className="mt-8 inline-block font-semibold text-pay underline underline-offset-4">
        Split your own bill with SplitSense
      </Link>
    </div>
  );
}

function Line({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span className="tabular-nums">{plain(cents)}</span>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-lg px-5 py-24">{children}</div>;
}
