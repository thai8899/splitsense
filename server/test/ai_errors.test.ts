import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { describeAiError } from '../src/server.js';

const apiError = (status: number, message: string) => Anthropic.APIError.generate(status, { error: { message } }, message, new Headers());

describe('describeAiError', () => {
  it('explains the common Anthropic failures in plain words', () => {
    expect(describeAiError(apiError(401, 'invalid x-api-key'), 'm')).toContain('AI_API_KEY');
    expect(describeAiError(apiError(404, 'model: m'), 'claude-x')).toContain('claude-x');
    expect(describeAiError(apiError(400, 'Your credit balance is too low'), 'm')).toContain('no credits');
    expect(describeAiError(apiError(429, 'rate'), 'm')).toContain('rate limit');
    expect(describeAiError(new Anthropic.APIConnectionError({ message: 'offline' }), 'm')).toContain('internet');
    expect(describeAiError(new Error('boom'), 'm')).toBe('The AI step failed. Please try again.');
  });
});
