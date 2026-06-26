import { describe, expect, it, vi } from 'vitest';
import { OpenAIEmbedder, type OpenAIEmbeddingsClient } from './openai-embedder.js';
import {
  ClaudeChat,
  type AnthropicMessagesClient,
  type AnthropicStreamEvent,
} from './claude-chat.js';
import { IdentityReranker } from './identity-reranker.js';
import { createProviders } from './index.js';
import type { ChatStreamEvent } from '@asab/shared';
import type { Config } from '../config.js';

describe('OpenAIEmbedder', () => {
  function fakeClient() {
    const create = vi.fn(async ({ input }: { model: string; input: string[] }) => ({
      // Encode each text's length so we can assert order is preserved.
      data: input.map((t, index) => ({ index, embedding: [t.length] })),
    }));
    return { embeddings: { create } } satisfies OpenAIEmbeddingsClient;
  }

  it('returns one vector per input, order preserved', async () => {
    const client = fakeClient();
    const embedder = new OpenAIEmbedder(client, 'text-embedding-3-small', 1536);
    const out = await embedder.embed(['a', 'bb', 'ccc']);
    expect(out).toEqual([[1], [2], [3]]);
    expect(client.embeddings.create).toHaveBeenCalledTimes(1);
  });

  it('preserves order across batch boundaries', async () => {
    const client = fakeClient();
    const embedder = new OpenAIEmbedder(client, 'm', 1536, 2);
    const out = await embedder.embed(['a', 'bb', 'ccc', 'dddd', 'e']);
    expect(out).toEqual([[1], [2], [3], [4], [1]]);
    expect(client.embeddings.create).toHaveBeenCalledTimes(3); // 2 + 2 + 1
  });

  it('sorts by response index when the API returns out of order', async () => {
    const create = vi.fn(async ({ input }: { model: string; input: string[] }) => ({
      // Return data reversed but correctly indexed — embedder must re-sort.
      data: input.map((t, index) => ({ index, embedding: [t.length] })).reverse(),
    }));
    const embedder = new OpenAIEmbedder({ embeddings: { create } }, 'm', 1536);
    const out = await embedder.embed(['a', 'bb', 'ccc']);
    expect(out).toEqual([[1], [2], [3]]);
  });

  it('passes the configured dimensions to the API', async () => {
    const client = fakeClient();
    await new OpenAIEmbedder(client, 'm', 1024).embed(['a']);
    expect(client.embeddings.create).toHaveBeenCalledWith(
      expect.objectContaining({ dimensions: 1024 }),
    );
  });

  it('short-circuits on empty input', async () => {
    const client = fakeClient();
    const embedder = new OpenAIEmbedder(client, 'm', 1536);
    expect(await embedder.embed([])).toEqual([]);
    expect(client.embeddings.create).not.toHaveBeenCalled();
  });
});

describe('ClaudeChat', () => {
  function clientYielding(events: AnthropicStreamEvent[]): AnthropicMessagesClient {
    return {
      messages: {
        create: async () =>
          (async function* () {
            for (const e of events) yield e;
          })(),
      },
    };
  }

  it('streams text deltas then a terminal done with usage and stopReason', async () => {
    const client = clientYielding([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    ]);
    const chat = new ClaudeChat(client, 'claude-haiku-4-5');

    const events: ChatStreamEvent[] = [];
    for await (const e of chat.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(e);
    }

    const text = events
      .filter((e): e is { type: 'text'; text: string } => e.type === 'text')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello world');
    expect(events.at(-1)).toEqual({
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'end_turn',
    });
  });

  it('ignores non-text (input_json_delta) deltas', async () => {
    const client = clientYielding([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta' } },
    ]);
    const chat = new ClaudeChat(client, 'm');
    const texts: string[] = [];
    for await (const e of chat.stream({ messages: [] })) {
      if (e.type === 'text') texts.push(e.text);
    }
    expect(texts).toEqual(['ok']);
  });

  it('yields a terminal error frame on mid-stream failure (not a throw)', async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        create: async () =>
          (async function* (): AsyncIterable<AnthropicStreamEvent> {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } };
            throw Object.assign(new Error('overloaded'), { status: 529 });
          })(),
      },
    };
    const chat = new ClaudeChat(client, 'm');
    const events: ChatStreamEvent[] = [];
    for await (const e of chat.stream({ messages: [] })) events.push(e);

    expect(events[0]).toEqual({ type: 'text', text: 'partial' });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'overloaded', retryable: true });
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('forwards the abort signal to the SDK', async () => {
    const create = vi.fn(async () => (async function* () {})());
    const chat = new ClaudeChat({ messages: { create } }, 'm');
    const controller = new AbortController();
    for await (const _e of chat.stream({ messages: [], signal: controller.signal })) {
      void _e;
    }
    expect(create).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal });
  });
});

describe('IdentityReranker', () => {
  it('preserves order with descending scores', async () => {
    const r = new IdentityReranker();
    const out = await r.rerank('q', ['a', 'b', 'c']);
    expect(out.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    expect(out[1]!.score).toBeGreaterThan(out[2]!.score);
  });

  it('respects topK', async () => {
    const r = new IdentityReranker();
    const out = await r.rerank('q', ['a', 'b', 'c', 'd'], 2);
    expect(out.map((x) => x.index)).toEqual([0, 1]);
  });

  it('returns [] for empty documents even with topK', async () => {
    const r = new IdentityReranker();
    expect(await r.rerank('q', [], 5)).toEqual([]);
  });
});

describe('createProviders', () => {
  it('wires impls and selects models/dimensions from config', () => {
    const config = {
      OPENAI_API_KEY: 'sk-x',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      EMBEDDING_MODEL: 'text-embedding-3-small',
      CHAT_MODEL: 'claude-haiku-4-5',
    } as unknown as Config;

    const providers = createProviders(config);
    expect(providers.embedder).toBeInstanceOf(OpenAIEmbedder);
    expect(providers.chat).toBeInstanceOf(ClaudeChat);
    expect(providers.reranker).toBeInstanceOf(IdentityReranker);
    expect(providers.embedder.model).toBe('text-embedding-3-small');
    expect(providers.embedder.dimensions).toBe(1536);
    expect(providers.chat.model).toBe('claude-haiku-4-5');
  });
});
