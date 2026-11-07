/** Test doubles shared across suites. */
import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike } from '../src/ai_agent.js';

/** Fake Anthropic client that replays scripted tool inputs and records requests. */
export function scriptedAnthropic(toolInputs: unknown[]): AnthropicLike & { requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let call = 0;
  return {
    requests,
    messages: {
      async create(body) {
        requests.push(structuredClone(body));
        const input = toolInputs[Math.min(call, toolInputs.length - 1)];
        call += 1;
        const toolName = (body.tool_choice as { name: string }).name;
        return {
          id: `msg_${call}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          stop_reason: 'tool_use',
          stop_sequence: null,
          content: [{ type: 'tool_use', id: `toolu_${call}`, name: toolName, input }],
          usage: { input_tokens: 10, output_tokens: 10 },
        } as unknown as Anthropic.Message;
      },
    },
  };
}

export const SAMPLE_EXTRACTION = {
  is_receipt: true,
  merchant: 'Saguaro Social Kitchen',
  currency: 'USD',
  date: '2026-11-05',
  items: [
    { name: 'Chicken Wings 12pc', quantity: 1, line_total: 16.0 },
    { name: 'Jollof Rice Bowl', quantity: 1, line_total: 14.5 },
    { name: 'Grilled Salmon', quantity: 1, line_total: 24.0 },
    { name: 'Margherita Pizza', quantity: 1, line_total: 18.0 },
    { name: 'Caesar Salad', quantity: 1, line_total: 11.0 },
    { name: 'Draft IPA', quantity: 3, line_total: 21.0 },
    { name: 'Sparkling Water', quantity: 1, line_total: 4.0 },
    { name: 'Churro Sundae', quantity: 1, line_total: 9.5 },
  ],
  subtotal: 118.0,
  tax: 10.15,
  tip: 0,
  service_fee: 0,
  discount: 0,
  total: 128.15,
  notes: [],
};

export const SAMPLE_ALLOCATION = {
  assignments: [
    { item_id: 'i1', participants: [{ name: 'Femi', weight: 1 }, { name: 'Ada', weight: 1 }], reason: '"Ada and I split the wings"' },
    { item_id: 'i2', participants: [{ name: 'Femi', weight: 1 }], reason: '"I had the jollof"' },
    { item_id: 'i3', participants: [{ name: 'Ada', weight: 1 }], reason: '"Ada had the salmon"' },
    { item_id: 'i4', participants: [{ name: 'Tolu', weight: 1 }, { name: 'Kemi', weight: 1 }], reason: '"Tolu and Kemi shared the pizza"' },
    { item_id: 'i5', participants: [{ name: 'Kemi', weight: 1 }], reason: '"Kemi had the salad"' },
    { item_id: 'i6', participants: [{ name: 'Tolu', weight: 2 }, { name: 'Femi', weight: 1 }], reason: '"Tolu had 2 beers, I had 1"' },
    { item_id: 'i7', participants: [{ name: 'Ada', weight: 1 }], reason: '"Ada had the water"' },
    { item_id: 'i8', participants: [{ name: 'Femi', weight: 1 }, { name: 'Ada', weight: 1 }, { name: 'Tolu', weight: 1 }, { name: 'Kemi', weight: 1 }], reason: '"we all shared dessert"' },
  ],
  tip: { mode: 'percent', value: 20 },
  clarifications: [],
};
