import { PayPalButtons, PayPalScriptProvider, usePayPalScriptReducer } from '@paypal/react-paypal-js';
import { useState } from 'react';
import { api, ApiError, type ShareView } from '../lib/api';
import { money } from '../lib/format';
import { Spinner } from './Spinner';

interface PaymentCheckoutProps {
  clientId: string;
  shareId: string;
  amountCents: number;
  currency: string;
  onPaid: (share: ShareView) => void;
}

type Phase =
  | { kind: 'ready' }
  | { kind: 'creating' }
  | { kind: 'approving' }
  | { kind: 'capturing' }
  | { kind: 'error'; message: string; debugId?: string };

/**
 * PayPal Smart Payment Buttons wired to our backend.
 *
 * - createOrder asks the server to create the order. The browser never sends
 *   an amount; the server prices the order from the stored split.
 * - onApprove asks the server to capture. A declined funding source triggers
 *   actions.restart() so the buyer can pick another one without starting over.
 */
export function PaymentCheckout(props: PaymentCheckoutProps) {
  return (
    <PayPalScriptProvider
      options={{
        clientId: props.clientId,
        currency: props.currency,
        intent: 'capture',
        components: 'buttons',
        enableFunding: 'venmo',
      }}
    >
      <Buttons {...props} />
    </PayPalScriptProvider>
  );
}

function Buttons({ shareId, amountCents, currency, onPaid }: PaymentCheckoutProps) {
  const [{ isPending, isRejected }] = usePayPalScriptReducer();
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });
  const busy = phase.kind === 'creating' || phase.kind === 'capturing';

  if (isRejected) {
    return (
      <p role="alert" className="rounded-md bg-bad/10 p-4 text-sm text-bad">
        PayPal checkout couldn’t load. Check your connection or disable content blockers for this page, then reload.
      </p>
    );
  }

  return (
    <div className="relative">
      {isPending && (
        <div className="flex items-center gap-3 py-6 text-sm text-ink-soft">
          <Spinner /> Loading PayPal checkout…
        </div>
      )}

      <div className={busy ? 'pointer-events-none opacity-40' : undefined} aria-busy={busy}>
        <PayPalButtons
          style={{ layout: 'vertical', shape: 'rect', label: 'pay', height: 48 }}
          forceReRender={[shareId, amountCents, currency]}
          createOrder={async () => {
            setPhase({ kind: 'creating' });
            try {
              const order = await api.createOrder(shareId);
              setPhase({ kind: 'approving' });
              return order.id;
            } catch (error) {
              setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'Could not start checkout.' });
              throw error;
            }
          }}
          onApprove={async (data, actions) => {
            setPhase({ kind: 'capturing' });
            try {
              const result = await api.captureOrder(shareId, data.orderID);
              onPaid(result.share);
            } catch (error) {
              if (error instanceof ApiError && error.body.issue === 'INSTRUMENT_DECLINED') {
                setPhase({ kind: 'error', message: 'That payment method was declined. Choose another one in PayPal.' });
                actions.restart();
                return;
              }
              setPhase({
                kind: 'error',
                message: error instanceof Error ? error.message : 'Payment could not be completed.',
                debugId: error instanceof ApiError ? (error.body.debugId as string | undefined) : undefined,
              });
            }
          }}
          onCancel={() => setPhase({ kind: 'ready' })}
          onError={(err) => {
            console.error('[paypal]', err);
            setPhase((current) =>
              current.kind === 'error' ? current : { kind: 'error', message: 'PayPal hit a problem. Try again in a moment.' },
            );
          }}
        />
      </div>

      {busy && (
        <div className="absolute inset-0 grid place-items-center" aria-live="polite">
          <div className="flex items-center gap-3 rounded-md bg-paper px-4 py-3 text-sm shadow">
            <Spinner />
            {phase.kind === 'creating' ? `Preparing your ${money(amountCents, currency)} payment…` : 'Confirming with PayPal…'}
          </div>
        </div>
      )}

      {phase.kind === 'error' && (
        <p role="alert" className="mt-3 rounded-md bg-bad/10 p-3 text-sm text-bad">
          {phase.message}
          {phase.debugId && <span className="mt-1 block text-xs opacity-80">PayPal reference: {phase.debugId}</span>}
        </p>
      )}
    </div>
  );
}
