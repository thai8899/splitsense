import { describe, expect, it } from 'vitest';
import { AgentUserError, SplitAgent } from '../src/ai_agent.js';
import { SAMPLE_ALLOCATION, SAMPLE_EXTRACTION, scriptedAnthropic } from './fakes.js';

const options = { model: 'claude-sonnet-5-5', maxRetries: 2, defaultCurrency: 'USD' };
const file = { data: Buffer.from('fake'), mediaType: 'image/png' as const };

describe('SplitAgent.extractReceipt', () => {
  it('returns a cents-based receipt on a clean read', async () => {
    const client = scriptedAnthropic([SAMPLE_EXTRACTION]);
    const stages: string[] = [];
    const result = await new SplitAgent(client, options).extractReceipt(file, (s) => stages.push(s));
    expect(result.receipt.items).toHaveLength(8);
    expect(result.receipt.items[0]).toMatchObject({ id: 'i1', totalCents: 1600 });
    expect(result.receipt.totalCents).toBe(12815);
    expect(result.attempts).toBe(1);
    expect(stages).toContain('reading_receipt');
    expect(client.requests[0].tool_choice).toMatchObject({ type: 'tool', name: 'record_receipt' });
    expect((client.requests[0].messages[0].content as any[])[0].type).toBe('image');
  });

  it('feeds arithmetic mismatches back to the model and accepts the correction', async () => {
    const misread = { ...SAMPLE_EXTRACTION, items: SAMPLE_EXTRACTION.items.map((i, n) => (n === 2 ? { ...i, line_total: 34.0 } : i)) };
    const client = scriptedAnthropic([misread, SAMPLE_EXTRACTION]);
    const result = await new SplitAgent(client, options).extractReceipt(file);
    expect(result.attempts).toBe(2);
    const feedback = client.requests[1].messages[2].content as any[];
    expect(feedback[0]).toMatchObject({ type: 'tool_result', is_error: true });
    expect(feedback[0].content).toContain('line items sum to 128.00 but subtotal is 118.00');
  });

  it('salvages with a review note when totals never reconcile', async () => {
    const misread = { ...SAMPLE_EXTRACTION, total: 130.0 };
    const result = await new SplitAgent(scriptedAnthropic([misread]), options).extractReceipt(file);
    expect(result.attempts).toBe(3);
    expect(result.notes.join(' ')).toContain('did not reconcile');
    expect(result.receipt.totalCents).toBe(12815);
  });

  it('rejects non-receipts immediately with a user-facing error', async () => {
    const client = scriptedAnthropic([{ ...SAMPLE_EXTRACTION, is_receipt: false, items: [] }]);
    await expect(new SplitAgent(client, options).extractReceipt(file)).rejects.toBeInstanceOf(AgentUserError);
    expect(client.requests).toHaveLength(1);
  });

  it('sends PDFs as document blocks and falls back on unsupported currencies', async () => {
    const client = scriptedAnthropic([{ ...SAMPLE_EXTRACTION, currency: 'JPY' }]);
    const result = await new SplitAgent(client, options).extractReceipt({ data: Buffer.from('%PDF-1.7'), mediaType: 'application/pdf' });
    expect((client.requests[0].messages[0].content as any[])[0].type).toBe('document');
    expect(result.receipt.currency).toBe('USD');
  });
});

describe('SplitAgent.allocate', () => {
  const receiptPromise = new SplitAgent(scriptedAnthropic([SAMPLE_EXTRACTION]), options).extractReceipt(file);
  const people = ['Femi', 'Ada', 'Tolu', 'Kemi'];

  it('maps assignments and tip overrides', async () => {
    const { receipt } = await receiptPromise;
    const result = await new SplitAgent(scriptedAnthropic([SAMPLE_ALLOCATION]), options).allocate(receipt, people, 'Femi', 'desc');
    expect(result.assignments).toHaveLength(8);
    expect(result.tipOverride).toEqual({ mode: 'percent', value: 20 });
  });

  it('canonicalises name casing and retries on unknown names or missing items', async () => {
    const { receipt } = await receiptPromise;
    const bad = {
      ...SAMPLE_ALLOCATION,
      assignments: [
        { ...SAMPLE_ALLOCATION.assignments[0], participants: [{ name: 'femi', weight: 1 }, { name: 'Bola', weight: 1 }] },
        ...SAMPLE_ALLOCATION.assignments.slice(1, 7),
      ],
    };
    const client = scriptedAnthropic([bad, SAMPLE_ALLOCATION]);
    const result = await new SplitAgent(client, options).allocate(receipt, people, 'Femi', 'desc');
    expect(result.attempts).toBe(2);
    const feedback = (client.requests[1].messages[2].content as any[])[0].content as string;
    expect(feedback).toContain('"Bola" is not a participant');
    expect(feedback).toContain('items not assigned: i8');
  });
});
