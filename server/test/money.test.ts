import { describe, expect, it } from 'vitest';
import { allocateByWeights, centsToDecimal, computeSplit, resolveTipCents, toCents, type Receipt } from '../src/money.js';

const receipt: Receipt = {
  merchant: 'Saguaro Social Kitchen',
  currency: 'USD',
  date: '2026-11-05',
  items: [
    { id: 'i1', name: 'Chicken Wings 12pc', quantity: 1, totalCents: 1600 },
    { id: 'i2', name: 'Jollof Rice Bowl', quantity: 1, totalCents: 1450 },
    { id: 'i3', name: 'Grilled Salmon', quantity: 1, totalCents: 2400 },
    { id: 'i4', name: 'Draft IPA', quantity: 3, totalCents: 2100 },
  ],
  subtotalCents: 7550,
  taxCents: 649,
  tipCents: 0,
  serviceFeeCents: 0,
  discountCents: 0,
  totalCents: 8199,
};

describe('toCents / centsToDecimal', () => {
  it('parses decimals without float drift', () => {
    expect(toCents('19.99')).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents('1,234.5')).toBe(123450);
    expect(toCents('-3.10')).toBe(-310);
    expect(toCents('2.675')).toBe(268);
    expect(() => toCents('abc')).toThrow();
  });
  it('formats cents for PayPal', () => {
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(123456)).toBe('1234.56');
    expect(() => centsToDecimal(1.5)).toThrow();
  });
});

describe('allocateByWeights', () => {
  it('never loses or creates a cent', () => {
    for (let amount = 0; amount < 500; amount += 7) {
      for (const weights of [[1, 1, 1], [2, 1], [1, 1, 1, 1, 1, 1, 1], [0.5, 0.25, 0.25]]) {
        const parts = allocateByWeights(amount, weights);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
      }
    }
  });
  it('is deterministic and favours earlier entries on ties', () => {
    expect(allocateByWeights(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateByWeights(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  });
  it('falls back to an even split when all weights are zero', () => {
    expect(allocateByWeights(10, [0, 0])).toEqual([5, 5]);
  });
});

describe('computeSplit', () => {
  const people = ['Femi', 'Ada', 'Tolu'];

  it('splits items by weight and spreads tax proportionally, summing exactly', () => {
    const result = computeSplit(receipt, people, [
      { itemId: 'i1', shares: [{ participant: 'Femi', weight: 1 }, { participant: 'Ada', weight: 1 }] },
      { itemId: 'i2', shares: [{ participant: 'Tolu', weight: 1 }] },
      { itemId: 'i3', shares: [{ participant: 'Ada', weight: 1 }] },
      { itemId: 'i4', shares: [{ participant: 'Femi', weight: 2 }, { participant: 'Tolu', weight: 1 }] },
    ]);
    const [femi, ada, tolu] = result.people;
    expect(femi.itemsCents).toBe(800 + 1400);
    expect(ada.itemsCents).toBe(800 + 2400);
    expect(tolu.itemsCents).toBe(1450 + 700);
    expect(result.people.reduce((s, p) => s + p.totalCents, 0)).toBe(result.grandTotalCents);
    expect(result.grandTotalCents).toBe(8199);
    expect(femi.items.find((l) => l.itemId === 'i4')?.portion).toBe('2/3 share');
    expect(result.unassignedItemIds).toEqual([]);
  });

  it('splits unassigned or invalid items evenly and reports them', () => {
    const result = computeSplit(receipt, people, [
      { itemId: 'i1', shares: [{ participant: 'Nobody', weight: 1 }] },
    ]);
    expect(result.unassignedItemIds).toEqual(['i1', 'i2', 'i3', 'i4']);
    expect(result.people.reduce((s, p) => s + p.totalCents, 0)).toBe(8199);
  });

  it('applies tip overrides on the pre-tax subtotal', () => {
    expect(resolveTipCents(receipt, { mode: 'percent', value: 20 })).toBe(1510);
    expect(resolveTipCents(receipt, { mode: 'amount', valueCents: 1000 })).toBe(1000);
    const result = computeSplit(receipt, people, [], { mode: 'percent', value: 20 });
    expect(result.tipCents).toBe(1510);
    expect(result.grandTotalCents).toBe(8199 + 1510);
    expect(result.people.reduce((s, p) => s + p.tipCents, 0)).toBe(1510);
  });

  it('handles discounts and service fees', () => {
    const withExtras: Receipt = { ...receipt, discountCents: 500, serviceFeeCents: 333 };
    const result = computeSplit(withExtras, people, []);
    expect(result.people.reduce((s, p) => s + p.totalCents, 0)).toBe(7550 + 649 + 333 - 500);
  });
});
