import { describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '@asab/shared';
import {
  ClaudeChat,
  type AnthropicMessagesClient,
  type AnthropicStreamEvent,
} from './claude-chat.js';

/** Fake Anthropic client: records create() args, yields the given events. */
function fakeClient(events: AnthropicStreamEvent[], opts: { throwErr?: unknown } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const client: AnthropicMessagesClient = {
    messages: {
      async create(args) {
        calls.push(args as Record<string, unknown>);
        if (opts.throwErr) throw opts.throwErr;
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  };
  return { client, calls };
}

async function drain(stream: AsyncIterable<ChatStreamEvent>) {
  let text = '';
  let done: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
  let error: Extract<ChatStreamEvent, { type: 'error' }> | undefined;
  for await (const e of stream) {
    if (e.type === 'text') text += e.text;
    else if (e.type === 'done') done = e;
    else error = e;
  }
  return { text, done, error };
}

const usageStream: AnthropicStreamEvent[] = [
  { type: 'message_start', message: { usage: { input_tokens: 11 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } },
  { type: 'message_delta', usage: { output_tokens: 7 }, delta: { stop_reason: 'end_turn' } },
];

describe('ClaudeChat', () => {
  it('maps Anthropic events to text deltas and captures usage + stop reason', async () => {
    const { client } = fakeClient(usageStream);
    const result = await drain(
      new ClaudeChat(client, 'claude-haiku-4-5').stream({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result.text).toBe('Hi there');
    expect(result.done?.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(result.done?.stopReason).toBe('end_turn');
    expect(result.error).toBeUndefined();
  });

  it('uses the per-request model override over the instance default', async () => {
    const { client, calls } = fakeClient(usageStream);
    await drain(
      new ClaudeChat(client, 'claude-haiku-4-5').stream({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(calls[0]?.model).toBe('claude-opus-4-6');
  });

  it('sends temperature to models that accept it', async () => {
    const { client, calls } = fakeClient(usageStream);
    await drain(
      new ClaudeChat(client, 'claude-haiku-4-5').stream({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
      }),
    );
    expect(calls[0]?.temperature).toBe(0.5);
  });

  it('omits temperature for models that reject sampling params (Opus 4.8)', async () => {
    const { client, calls } = fakeClient(usageStream);
    await drain(
      new ClaudeChat(client, 'claude-haiku-4-5').stream({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
      }),
    );
    expect('temperature' in (calls[0] ?? {})).toBe(false);
  });

  it('yields a terminal error frame instead of throwing (retryable on 529)', async () => {
    const { client } = fakeClient([], { throwErr: { status: 529 } });
    const result = await drain(
      new ClaudeChat(client, 'claude-haiku-4-5').stream({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result.error?.retryable).toBe(true);
    expect(result.done).toBeUndefined();
  });

  it('marks a 400 error as non-retryable', async () => {
    const { client } = fakeClient([], { throwErr: { status: 400 } });
    const result = await drain(
      new ClaudeChat(client, 'claude-haiku-4-5').stream({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result.error?.retryable).toBe(false);
  });
});
