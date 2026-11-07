/**
 * Deterministic money math for splitting a receipt.
 *
 * Design rule: the AI decides *who* had *what*; this module decides *how much*.
 * All amounts are integer minor units (cents). Every split uses the
 * largest-remainder method, so the per-person amounts always add up to the
 * bill total exactly — no "missing penny" — and the same input always yields
 * the same output.
 */

/** Currencies PayPal supports with two decimal places. Zero-decimal currencies (JPY, HUF, TWD) are excluded on purpose. */
export const SUPPORTED_CURRENCIES = new Set([
  'AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'ILS', 'MXN', 'MYR',
  'NOK', 'NZD', 'PHP', 'PLN', 'GBP', 'SGD', 'SEK', 'CHF', 'THB', 'USD',
]);

export interface ReceiptItem {
  /** Stable identifier such as "i1", referenced by assignments. */
  id: string;
  name: string;
  quantity: number;
  /** Line total for this item (quantity × unit price), in cents. */
  totalCents: number;
}

export interface Receipt {
  merchant: string;
  currency: string;
  date: string | null;
  items: ReceiptItem[];
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  serviceFeeCents: number;
  /** Positive number representing money taken off the bill. */
  discountCents: number;
  totalCents: number;
}

export interface WeightedShare {
  participant: string;
  /** Relative weight. [1,1] is an even split, [2,1] gives the first person two thirds. */
  weight: number;
}

export interface ItemAssignment {
  itemId: string;
  shares: WeightedShare[];
  /** Short explanation from the AI (or "Edited manually"), shown in the review UI. */
  reason?: string;
}

export type TipOverride =
  | { mode: 'percent'; value: number }
  | { mode: 'amount'; valueCents: number };

export interface PersonItemLine {
  itemId: string;
  name: string;
  /** Human-readable portion, e.g. "1/3 share" or "full". */
  portion: string;
  amountCents: number;
}

export interface PersonBreakdown {
  participant: string;
  items: PersonItemLine[];
  itemsCents: number;
  taxCents: number;
  tipCents: number;
  serviceFeeCents: number;
  discountCents: number;
  totalCents: number;
}

export interface SplitResult {
  currency: string;
  people: PersonBreakdown[];
  /** Items that had no valid assignment and were split evenly across everyone. */
  unassignedItemIds: string[];
  tipCents: number;
  grandTotalCents: number;
}

/**
 * Convert a decimal amount ("12.5", 12.5, "-3.10") to integer cents without
 * binary floating point drift. Fractions beyond two places are rounded half-up.
 */
export function toCents(value: number | string): number {
  const text = typeof value === 'number' ? value.toFixed(6) : value.trim().replace(/[,\s]/g, '');
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new Error(`Not a valid monetary amount: "${String(value)}"`);
  }
  const negative = match[1] === '-';
  const whole = Number(match[2] || '0');
  const fraction = (match[3] ?? '').padEnd(3, '0');
  let cents = whole * 100 + Number(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1;
  return negative ? -cents : cents;
}

/** Format cents as the decimal string PayPal expects ("1234" -> "12.34"). */
export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`Cents must be an integer, got ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Split an integer amount by relative weights using the largest-remainder
 * method. Ties are broken by input order, so results are deterministic.
 * Negative amounts are supported (split the magnitude, then negate).
 */
export function allocateByWeights(amountCents: number, weights: number[]): number[] {
  if (!Number.isInteger(amountCents)) throw new Error('amountCents must be an integer');
  if (weights.length === 0) return [];
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new Error('Weights must be finite, non-negative numbers');
  }
  const weightSum = weights.reduce((sum, w) => sum + w, 0);
  if (weightSum === 0) {
    // Nothing to weight by: fall back to an even split.
    return allocateByWeights(amountCents, weights.map(() => 1));
  }
  const magnitude = Math.abs(amountCents);
  const exact = weights.map((w) => (magnitude * w) / weightSum);
  const floors = exact.map(Math.floor);
  let remainder = magnitude - floors.reduce((sum, v) => sum + v, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (remainder === 0) break;
    floors[index] += 1;
    remainder -= 1;
  }
  return amountCents < 0 ? floors.map((v) => (v === 0 ? 0 : -v)) : floors;
}

/** Describe a weight as a friendly fraction ("full", "1/2 share", "2/5 share"). */
function describePortion(weight: number, total: number): string {
  if (weight === total) return 'full';
  if (Number.isInteger(weight) && Number.isInteger(total)) {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const d = gcd(weight, total);
    return `${weight / d}/${total / d} share`;
  }
  return `${Math.round((weight / total) * 100)}% share`;
}

/** Resolve the tip in cents: an explicit override wins over what the receipt printed. */
export function resolveTipCents(receipt: Receipt, override: TipOverride | null | undefined): number {
  if (!override) return receipt.tipCents;
  if (override.mode === 'amount') return Math.max(0, Math.round(override.valueCents));
  const pct = Math.min(Math.max(override.value, 0), 100);
  return Math.round((receipt.subtotalCents * pct) / 100);
}

/**
 * Compute exactly what each participant owes.
 *
 * 1. Every item is split across its assignees by weight (largest remainder).
 *    Items with no usable assignment are split evenly across all participants.
 * 2. Tax, tip, service fee and discount are distributed in proportion to each
 *    person's item subtotal, again with largest remainder.
 * 3. The sum of everyone's total equals the bill's grand total, always.
 */
export function computeSplit(
  receipt: Receipt,
  participants: string[],
  assignments: ItemAssignment[],
  tipOverride?: TipOverride | null,
): SplitResult {
  if (participants.length === 0) throw new Error('At least one participant is required');
  const index = new Map(participants.map((name, i) => [name, i]));
  const people: PersonBreakdown[] = participants.map((participant) => ({
    participant,
    items: [],
    itemsCents: 0,
    taxCents: 0,
    tipCents: 0,
    serviceFeeCents: 0,
    discountCents: 0,
    totalCents: 0,
  }));

  const assignmentByItem = new Map(assignments.map((a) => [a.itemId, a]));
  const unassignedItemIds: string[] = [];

  for (const item of receipt.items) {
    const raw = assignmentByItem.get(item.id)?.shares ?? [];
    // Merge duplicate participants and drop unknown names or non-positive weights.
    const merged = new Map<string, number>();
    for (const share of raw) {
      if (!index.has(share.participant) || !(share.weight > 0)) continue;
      merged.set(share.participant, (merged.get(share.participant) ?? 0) + share.weight);
    }
    let shares = [...merged.entries()].map(([participant, weight]) => ({ participant, weight }));
    if (shares.length === 0) {
      unassignedItemIds.push(item.id);
      shares = participants.map((participant) => ({ participant, weight: 1 }));
    }
    // Keep participant order stable so rounding is deterministic.
    shares.sort((a, b) => index.get(a.participant)! - index.get(b.participant)!);
    const weightTotal = shares.reduce((sum, s) => sum + s.weight, 0);
    const amounts = allocateByWeights(item.totalCents, shares.map((s) => s.weight));
    shares.forEach((share, i) => {
      const person = people[index.get(share.participant)!];
      person.items.push({
        itemId: item.id,
        name: item.name,
        portion: describePortion(share.weight, weightTotal),
        amountCents: amounts[i],
      });
      person.itemsCents += amounts[i];
    });
  }

  const tipCents = resolveTipCents(receipt, tipOverride);
  const basis = people.map((p) => Math.max(p.itemsCents, 0));
  const spread = (amount: number): number[] => allocateByWeights(amount, basis);
  const tax = spread(receipt.taxCents);
  const tip = spread(tipCents);
  const fee = spread(receipt.serviceFeeCents);
  const discount = spread(receipt.discountCents);

  people.forEach((person, i) => {
    person.taxCents = tax[i];
    person.tipCents = tip[i];
    person.serviceFeeCents = fee[i];
    person.discountCents = discount[i];
    person.totalCents =
      person.itemsCents + person.taxCents + person.tipCents + person.serviceFeeCents - person.discountCents;
  });

  const itemsTotal = receipt.items.reduce((sum, item) => sum + item.totalCents, 0);
  const grandTotalCents =
    itemsTotal + receipt.taxCents + tipCents + receipt.serviceFeeCents - receipt.discountCents;

  return { currency: receipt.currency, people, unassignedItemIds, tipCents, grandTotalCents };
}
