/**
 * Google Gemini backend for the SplitSense agent.
 *
 * The agent loop in ai_agent.ts speaks the Anthropic Messages shape (forced
 * tool call -> tool_use block, tool_result feedback on retry). This adapter
 * implements that same `AnthropicLike` interface on top of Gemini function
 * calling, so the prompts, schemas, validation and self-correction loop are
 * shared between providers and only the transport differs.
 *
 * Gemini 3 models attach a `thoughtSignature` to function-call parts and
 * require it back on the next turn; the adapter keeps the model's original
 * parts per tool call and replays them verbatim on retries.
 */
import type Anthropic from '@anthropic-ai/sdk';
import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from '@google/genai';
import { randomUUID } from 'node:crypto';
import type { AnthropicLike } from './ai_agent.js';

/** The slice of the GenAI SDK this adapter uses; lets tests inject a fake. */
export interface GeminiModelsLike {
  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
}

/**
 * Gemini accepts standard JSON Schema through `parametersJsonSchema`, with a
 * few keywords unsupported. Normalise the ones the tool schemas use:
 * `type: [x, "null"]` becomes `anyOf`, and `exclusiveMinimum` becomes `minimum`.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'exclusiveMinimum') {
      out.minimum = value;
      continue;
    }
    if (key === 'type' && Array.isArray(value)) {
      out.anyOf = value.map((type) => ({ type }));
      continue;
    }
    out[key] = toGeminiSchema(value);
  }
  return out;
}

export class GeminiAdapter implements AnthropicLike {
  /** Original model turns keyed by the tool_use id we handed back, for faithful replay. */
  private readonly modelTurns = new Map<string, Content>();

  constructor(private readonly models: GeminiModelsLike) {}

  readonly messages = {
    create: async (body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
      const tool = body.tools?.[0] as Anthropic.Tool | undefined;
      if (!tool) throw new Error('GeminiAdapter requires exactly one tool');

      const response = await this.models.generateContent({
        model: body.model,
        contents: this.toContents(body.messages),
        config: {
          systemInstruction: typeof body.system === 'string' ? body.system : undefined,
          // Thinking tokens count toward the output budget on Gemini 3; leave room.
          maxOutputTokens: Math.max(body.max_tokens, 16_384),
          tools: [
            {
              functionDeclarations: [
                { name: tool.name, description: tool.description, parametersJsonSchema: toGeminiSchema(tool.input_schema) },
              ],
            },
          ],
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [tool.name] },
          },
        },
      });

      const content = response.candidates?.[0]?.content;
      const call = content?.parts?.find((part) => part.functionCall)?.functionCall;
      if (!content || !call) {
        const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? 'unknown';
        throw new Error(`Gemini returned no function call (finishReason=${reason})`);
      }
      const id = `toolu_${randomUUID()}`;
      this.modelTurns.set(id, content);

      return {
        id: response.responseId ?? `msg_${randomUUID()}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        stop_reason: 'tool_use',
        stop_sequence: null,
        content: [{ type: 'tool_use', id, name: call.name ?? tool.name, input: call.args ?? {} }],
        usage: {
          input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
          output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      } as unknown as Anthropic.Message;
    },
  };

  /** Translate Anthropic-style messages into Gemini contents. */
  private toContents(messages: Anthropic.MessageParam[]): Content[] {
    const toolNames = new Map<string, string>();
    return messages.map((message): Content => {
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content } as const] : message.content;

      if (message.role === 'assistant') {
        const toolUse = blocks.find((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
        if (toolUse) {
          toolNames.set(toolUse.id, toolUse.name);
          const original = this.modelTurns.get(toolUse.id);
          if (original) return { role: 'model', parts: original.parts };
          return { role: 'model', parts: [{ functionCall: { name: toolUse.name, args: toolUse.input as Record<string, unknown> } }] };
        }
      }

      const parts: Part[] = [];
      for (const block of blocks) {
        switch (block.type) {
          case 'text':
            parts.push({ text: block.text });
            break;
          case 'image':
          case 'document':
            if (block.source.type === 'base64') {
              parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
            }
            break;
          case 'tool_result': {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
            parts.push({
              functionResponse: {
                name: toolNames.get(block.tool_use_id) ?? 'tool',
                response: block.is_error ? { error: text } : { output: text },
              },
            });
            break;
          }
          default:
            break;
        }
      }
      return { role: message.role === 'assistant' ? 'model' : 'user', parts };
    });
  }
}

export function createGeminiAdapter(apiKey: string): GeminiAdapter {
  const ai = new GoogleGenAI({ apiKey });
  return new GeminiAdapter(ai.models);
}
