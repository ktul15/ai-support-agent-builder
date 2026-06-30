import type { Chat, ChatRequest, ChatStreamEvent, ChatUsage } from '@asab/shared';

export interface FakeChatOptions {
  /** Text to stream back, token-by-token (default a short grounded answer). */
  reply?: string;
  usage?: ChatUsage;
  /** If set, stream a single terminal error frame instead of text + done. */
  error?: string;
}

/**
 * Deterministic, offline Chat for tests and verify scripts — streams a fixed
 * reply token-by-token then a `done` with usage, so the generation path is
 * provable without calling (or paying for) Claude. Records the last request so
 * tests can assert model/system/messages were passed through.
 */
export class FakeChat implements Chat {
  readonly model = 'fake-chat';
  lastRequest?: ChatRequest;

  constructor(private readonly options: FakeChatOptions = {}) {}

  async *stream(req: ChatRequest): AsyncIterable<ChatStreamEvent> {
    this.lastRequest = req;
    if (this.options.error) {
      yield { type: 'error', message: this.options.error, retryable: false };
      return;
    }
    const reply = this.options.reply ?? 'Refunds are processed within 30 days [1].';
    for (const token of reply.split(/(\s+)/)) {
      if (token) yield { type: 'text', text: token };
    }
    yield {
      type: 'done',
      usage: this.options.usage ?? { inputTokens: 42, outputTokens: 8 },
      stopReason: 'end_turn',
    };
  }
}
