import type { GenerateContentParameters, GenerateContentResponse } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { RECORD_RECEIPT_TOOL, SplitAgent } from '../src/ai_agent.js';
import { GeminiAdapter, toGeminiSchema } from '../src/gemini_adapter.js';
import { SAMPLE_EXTRACTION } from './fakes.js';

function fakeGemini(argsSequence: unknown[]) {
  const calls: GenerateContentParameters[] = [];
  let n = 0;
  return {
    calls,
    async generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse> {
      calls.push(structuredClone(params));
      const args = argsSequence[Math.min(n, argsSequence.length - 1)];
      n += 1;
      return {
        candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'record_receipt', args }, thoughtSignature: `sig-${n}` }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
      } as unknown as GenerateContentResponse;
    },
  };
}

describe('toGeminiSchema', () => {
  it('rewrites nullable unions and exclusiveMinimum', () => {
    expect(toGeminiSchema({ type: ['string', 'null'] })).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(toGeminiSchema({ type: 'number', exclusiveMinimum: 0 })).toEqual({ type: 'number', minimum: 0 });
    const schema = toGeminiSchema(RECORD_RECEIPT_TOOL.input_schema) as any;
    expect(schema.properties.date.anyOf).toBeDefined();
  });
});

describe('GeminiAdapter resilience', () => {
  const tool = { name: 'record_receipt', description: 'd', input_schema: { type: 'object' as const, properties: {} } };
  const body = { model: 'main', max_tokens: 100, tools: [tool], tool_choice: { type: 'tool' as const, name: 'record_receipt' }, messages: [{ role: 'user' as const, content: 'hi' }] };
  const ok = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'record_receipt', args: {} } }] } }] } as unknown as GenerateContentResponse;
  const busy = Object.assign(new Error('high demand'), { status: 503 });

  it('retries a busy model, then falls back to the second model', async () => {
    const seen: string[] = [];
    const models = { async generateContent(p: GenerateContentParameters) { seen.push(p.model); if (p.model === 'main') throw busy; return ok; } };
    const adapter = new GeminiAdapter(models, { fallbackModel: 'backup', retryDelaysMs: [0, 0], sleep: async () => undefined });
    await adapter.messages.create(body as any);
    expect(seen).toEqual(['main', 'main', 'main', 'backup']);
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    const models = { async generateContent() { calls += 1; throw Object.assign(new Error('bad key'), { status: 400 }); } };
    const adapter = new GeminiAdapter(models, { fallbackModel: 'backup', retryDelaysMs: [0], sleep: async () => undefined });
    await expect(adapter.messages.create(body as any)).rejects.toThrow('bad key');
    expect(calls).toBe(1);
  });
});

describe('GeminiAdapter with SplitAgent', () => {
  const options = { model: 'gemini-3.5-flash', maxRetries: 2, defaultCurrency: 'USD' };
  const file = { data: Buffer.from('img'), mediaType: 'image/png' as const };

  it('forces the function call and sends the image inline', async () => {
    const gemini = fakeGemini([SAMPLE_EXTRACTION]);
    const result = await new SplitAgent(new GeminiAdapter(gemini), options).extractReceipt(file);
    expect(result.receipt.totalCents).toBe(12815);
    const req = gemini.calls[0];
    expect(req.config?.toolConfig?.functionCallingConfig).toMatchObject({ mode: 'ANY', allowedFunctionNames: ['record_receipt'] });
    expect((req.contents as any)[0].parts[0].inlineData).toMatchObject({ mimeType: 'image/png' });
    expect(req.config?.systemInstruction).toContain('receipt reader');
  });

  it('replays the original model turn (with thought signature) and returns validation errors on retry', async () => {
    const misread = { ...SAMPLE_EXTRACTION, total: 999 };
    const gemini = fakeGemini([misread, SAMPLE_EXTRACTION]);
    const result = await new SplitAgent(new GeminiAdapter(gemini), options).extractReceipt(file);
    expect(result.attempts).toBe(2);
    const contents = gemini.calls[1].contents as any[];
    expect(contents[1]).toMatchObject({ role: 'model', parts: [{ thoughtSignature: 'sig-1' }] });
    expect(contents[2].parts[0].functionResponse.name).toBe('record_receipt');
    expect(contents[2].parts[0].functionResponse.response.error).toContain('Validation failed');
  });
});
