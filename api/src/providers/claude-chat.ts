import type { Chat, ChatRequest, ChatStopReason, ChatStreamEvent, ChatUsage } from '@asab/shared';
import { modelSupportsSamplingParams } from './chat-models.js';

/** Minimal slice of the Anthropic streaming event shape we read. */
export interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
}

/** Minimal structural slice of the Anthropic client (streaming messages). */
export interface AnthropicMessagesClient {
  messages: {
    create(
      args: {
        model: string;
        max_tokens: number;
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        temperature?: number;
        stream: true;
      },
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<AnthropicStreamEvent>>;
  };
}

const DEFAULT_MAX_TOKENS = 1024;

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

export class ClaudeChat implements Chat {
  constructor(
    private readonly client: AnthropicMessagesClient,
    readonly model: string,
  ) {}

  async *stream(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: ChatStopReason | undefined;

    try {
      // Per-request override (per-assistant model) falls back to the default.
      const model = req.model ?? this.model;
      const stream = await this.client.messages.create(
        {
          model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: req.system,
          messages: req.messages,
          // Opus 4.7/4.8 and Fable 5 REJECT temperature with a 400 — only send it
          // to models that accept sampling params (steer the rest via prompt).
          ...(modelSupportsSamplingParams(model) ? { temperature: req.temperature } : {}),
          stream: true,
        },
        req.signal ? { signal: req.signal } : undefined,
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          // Relay every text delta, including empty strings.
          if (typeof event.delta.text === 'string') {
            yield { type: 'text', text: event.delta.text };
          }
        } else if (event.type === 'message_start') {
          inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
        } else if (event.type === 'message_delta') {
          // message_delta carries cumulative output usage and the stop reason.
          outputTokens = event.usage?.output_tokens ?? outputTokens;
          stopReason = (event.delta?.stop_reason as ChatStopReason | undefined) ?? stopReason;
        }
      }
    } catch (err) {
      // Terminal error frame instead of throwing out of the generator, so the
      // SSE layer can emit a structured error after any text already streamed.
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        retryable: isRetryable(err),
      };
      return;
    }

    const usage: ChatUsage = { inputTokens, outputTokens };
    yield { type: 'done', usage, stopReason };
  }
}
