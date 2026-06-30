import { describe, expect, it } from 'vitest';
import { FakeChat } from '../providers/fake-chat.js';
import { createGenerationService, collectAnswer } from './generation-service.js';

const base = {
  model: 'claude-haiku-4-5',
  system: 'Answer only from the sources.',
  question: 'How long do refunds take?',
  context: '[1] "Refund Policy" — page 1\nRefunds within 30 days.',
};

describe('generation service', () => {
  it('streams the answer and captures usage on done', async () => {
    const chat = new FakeChat({
      reply: 'Within 30 days [1].',
      usage: { inputTokens: 50, outputTokens: 6 },
    });
    const result = await collectAnswer(createGenerationService(chat).stream(base));
    expect(result.text).toBe('Within 30 days [1].');
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 6 });
    expect(result.stopReason).toBe('end_turn');
    expect(result.error).toBeUndefined();
  });

  it('selects the per-assistant model and passes the system prompt through', async () => {
    const chat = new FakeChat();
    await collectAnswer(
      createGenerationService(chat).stream({ ...base, model: 'claude-opus-4-8' }),
    );
    expect(chat.lastRequest?.model).toBe('claude-opus-4-8');
    expect(chat.lastRequest?.system).toBe(base.system);
  });

  it('builds the user turn from the sources block and the question', async () => {
    const chat = new FakeChat();
    await collectAnswer(createGenerationService(chat).stream(base));
    const content = chat.lastRequest?.messages[0]?.content ?? '';
    expect(content).toContain(base.context);
    expect(content).toContain('Question: How long do refunds take?');
  });

  it('falls back to a placeholder when there are no sources', async () => {
    const chat = new FakeChat();
    await collectAnswer(createGenerationService(chat).stream({ ...base, context: '' }));
    expect(chat.lastRequest?.messages[0]?.content).toContain('(no sources found)');
  });

  it('surfaces a terminal error frame', async () => {
    const chat = new FakeChat({ error: 'upstream 529' });
    const result = await collectAnswer(createGenerationService(chat).stream(base));
    expect(result.error).toEqual({ message: 'upstream 529', retryable: false });
  });

  it('rejects a model that is not on the allowlist', () => {
    const chat = new FakeChat();
    expect(() => createGenerationService(chat).stream({ ...base, model: 'gpt-4o' })).toThrow(
      /not in the allowlist/,
    );
  });

  it('falls back to the provider default model when none is given', async () => {
    const chat = new FakeChat();
    await collectAnswer(
      createGenerationService(chat).stream({
        system: base.system,
        question: base.question,
        context: base.context,
      }),
    );
    expect(chat.lastRequest?.model).toBeUndefined();
  });
});
