import type { Chat, ChatStreamEvent, ChatUsage, ChatStopReason } from '@asab/shared';
import { isAllowedChatModel } from '../providers/chat-models.js';

// Cited RAG answers span multiple sources — give a roomier default than the
// provider's generic 1024 so an answer isn't truncated mid-citation (F5).
const DEFAULT_RAG_MAX_TOKENS = 2048;

export interface GenerateParams {
  /**
   * Model id for this answer — the assistant's configured model (#22). Omit to
   * use the provider's default (Haiku). Validated against the allowlist when set.
   */
  model?: string;
  /** Grounding system prompt (#26 owns the contract; passed through here). */
  system: string;
  question: string;
  /** Assembled numbered sources block (#21). Empty when there are no sources. */
  context: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface GenerationService {
  /** Stream the grounded answer token-by-token (ending in `done` or `error`). */
  stream(params: GenerateParams): AsyncIterable<ChatStreamEvent>;
}

/** Build the user turn: the numbered sources, then the question. */
function userMessage(context: string, question: string): string {
  const sources = context.trim().length > 0 ? context : '(no sources found)';
  return `Sources:\n${sources}\n\nQuestion: ${question}`;
}

/**
 * Wraps the Chat provider for RAG answer generation: assembles the grounded
 * request (system contract + sources + question), selects the per-assistant
 * model, and streams the answer. Usage/stop-reason ride the terminal `done`
 * event; collectAnswer() drains a stream for non-streaming callers/tests.
 */
export function createGenerationService(chat: Chat): GenerationService {
  return {
    stream(params) {
      // tenant-configurable model -> reject anything not on the allowlist before
      // it reaches the provider (fail fast, not an opaque upstream 400) (F1).
      if (params.model !== undefined && !isAllowedChatModel(params.model)) {
        throw new Error(`generation: model "${params.model}" is not in the allowlist`);
      }
      return chat.stream({
        model: params.model,
        system: params.system,
        messages: [{ role: 'user', content: userMessage(params.context, params.question) }],
        maxTokens: params.maxTokens ?? DEFAULT_RAG_MAX_TOKENS,
        temperature: params.temperature,
        signal: params.signal,
      });
    },
  };
}

export interface CollectedAnswer {
  text: string;
  usage?: ChatUsage;
  stopReason?: ChatStopReason;
  error?: { message: string; retryable: boolean };
}

/** Drain a chat stream into the full answer text + captured usage/stop/error. */
export async function collectAnswer(
  stream: AsyncIterable<ChatStreamEvent>,
): Promise<CollectedAnswer> {
  let text = '';
  const result: CollectedAnswer = { text: '' };
  for await (const event of stream) {
    if (event.type === 'text') text += event.text;
    else if (event.type === 'done') {
      result.usage = event.usage;
      result.stopReason = event.stopReason;
    } else if (event.type === 'error') {
      result.error = { message: event.message, retryable: event.retryable };
    }
  }
  result.text = text;
  return result;
}
