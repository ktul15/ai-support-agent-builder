import { describe, it, expect } from 'vitest';
import { collectChat } from './sse.js';

describe('collectChat', () => {
  it('accumulates token text and captures the done payload', () => {
    const out = collectChat([
      { event: 'token', data: JSON.stringify({ text: 'Refunds ' }) },
      { event: 'token', data: JSON.stringify({ text: 'take 5 days.' }) },
      {
        event: 'done',
        data: JSON.stringify({ grounded: true, citations: [{ title: 'returns-and-refunds.md' }] }),
      },
    ]);
    expect(out.answer).toBe('Refunds take 5 days.');
    expect(out.grounded).toBe(true);
    expect(out.citations).toEqual([{ title: 'returns-and-refunds.md' }]);
    expect(out.error).toBe(false);
  });

  it('flags an error frame so it is not mistaken for an answer', () => {
    const out = collectChat([
      { event: 'token', data: JSON.stringify({ text: 'partial' }) },
      { event: 'error', data: JSON.stringify({ message: 'boom' }) },
    ]);
    expect(out.error).toBe(true);
  });
});
