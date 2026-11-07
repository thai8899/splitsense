/**
 * Bill domain service: turns stored bills into API views, shares and PayPal
 * order inputs. Pure functions over records — no I/O — so they are easy to test.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BillRecord, NewShare, ShareRecord } from './db.js';
import { PAID_STATUSES } from './db.js';
import { computeSplit, type PersonBreakdown, type SplitResult } from './money.js';
import type { CreateOrderInput, OrderLineItem } from './paypal.js';

/** URL-safe random identifier with `bytes` bytes of entropy. */
export function newId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashAdminToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}

/** Constant-time comparison of a presented admin token against the stored hash. */
export function verifyAdminToken(token: string | undefined, storedHash: string, secret: string): boolean {
  if (!token) return false;
  const presented = Buffer.from(hashAdminToken(token, secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

export function splitForBill(bill: BillRecord): SplitResult {
  return computeSplit(bill.receipt, bill.participants, bill.assignments, bill.tipOverride);
}

/** Create one share per participant. The host's own share needs no payment. */
export function buildShares(bill: BillRecord, split: SplitResult): NewShare[] {
  return split.people.map((person) => {
    const isHost = person.participant === bill.hostName;
    return {
      id: newId(16),
      billId: bill.id,
      participant: person.participant,
      isHost,
      amountCents: person.totalCents,
      currency: split.currency,
      breakdown: person,
      status: isHost || person.totalCents <= 0 ? 'host' : 'awaiting',
    };
  });
}

/** Map a person's breakdown onto a PayPal Orders v2 purchase unit. */
export function orderInputForShare(
  bill: BillRecord,
  share: ShareRecord,
  appBaseUrl: string,
): CreateOrderInput {
  const b: PersonBreakdown = share.breakdown;
  const items: OrderLineItem[] = b.items.map((line) => ({
    name: line.portion === 'full' ? line.name : `${line.name} (${line.portion})`,
    amountCents: line.amountCents,
  }));
  if (b.tipCents > 0) items.push({ name: 'Tip (your share)', amountCents: b.tipCents });
  const payUrl = `${appBaseUrl.replace(/\/$/, '')}/pay/${share.id}`;
  return {
    referenceId: share.id,
    currency: share.currency,
    description: `${share.participant}'s share of ${bill.title} at ${bill.receipt.merchant}`,
    items,
    taxCents: b.taxCents,
    handlingCents: b.serviceFeeCents,
    discountCents: b.discountCents,
    returnUrl: `${payUrl}?result=approved`,
    cancelUrl: `${payUrl}?result=cancelled`,
  };
}

export interface PublicShareView {
  id: string;
  participant: string;
  amountCents: number;
  currency: string;
  status: ShareRecord['status'];
  paid: boolean;
  webhookVerified: boolean;
  paidAt: string | null;
  payerName: string | null;
  breakdown: PersonBreakdown;
  payUrl: string;
}

export function shareView(share: ShareRecord, appBaseUrl: string): PublicShareView {
  return {
    id: share.id,
    participant: share.participant,
    amountCents: share.amountCents,
    currency: share.currency,
    status: share.status,
    paid: PAID_STATUSES.has(share.status),
    webhookVerified: share.webhookVerified,
    paidAt: share.paidAt,
    payerName: share.payerName,
    breakdown: share.breakdown,
    payUrl: `${appBaseUrl.replace(/\/$/, '')}/pay/${share.id}`,
  };
}

/** Full view for the host (requires the admin token). */
export function billView(bill: BillRecord, shares: ShareRecord[], appBaseUrl: string) {
  const split = splitForBill(bill);
  const owedShares = shares.filter((s) => s.status !== 'host');
  const collectedCents = owedShares
    .filter((s) => PAID_STATUSES.has(s.status))
    .reduce((sum, s) => sum + s.amountCents, 0);
  const owedCents = owedShares.reduce((sum, s) => sum + s.amountCents, 0);
  return {
    id: bill.id,
    title: bill.title,
    hostName: bill.hostName,
    participants: bill.participants,
    status: bill.status,
    instructions: bill.instructions,
    notes: bill.notes,
    receipt: bill.receipt,
    assignments: bill.assignments,
    tipOverride: bill.tipOverride,
    split,
    shares: shares.map((s) => shareView(s, appBaseUrl)),
    progress: { collectedCents, owedCents, paidCount: owedShares.filter((s) => PAID_STATUSES.has(s.status)).length, owedCount: owedShares.length },
    createdAt: bill.createdAt,
  };
}

export type BillView = ReturnType<typeof billView>;
