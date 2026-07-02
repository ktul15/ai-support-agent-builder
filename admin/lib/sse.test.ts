import { describe, expect, it } from 'vitest';
import { parseSseFrames } from './sse.js';

describe('parseSseFrames', () => {
  it('parses a complete event/data frame', () => {
    const { frames, rest } = parseSseFrames('event: token\ndata: {"text":"hi"}\n\n');
    expect(frames).toEqual([{ event: 'token', data: '{"text":"hi"}' }]);
    expect(rest).toBe('');
  });

  it('parses multiple frames and skips heartbeat comments', () => {
    const buf = 'event: token\ndata: a\n\n:\n\nevent: done\ndata: {}\n\n';
    const { frames } = parseSseFrames(buf);
    expect(frames.map((f) => f.event)).toEqual(['token', 'done']);
  });

  it('carries an incomplete trailing frame as rest', () => {
    const { frames, rest } = parseSseFrames('event: token\ndata: a\n\nevent: tok');
    expect(frames).toHaveLength(1);
    expect(rest).toBe('event: tok');
  });

  it('defaults the event name to message when absent', () => {
    const { frames } = parseSseFrames('data: plain\n\n');
    expect(frames[0]).toEqual({ event: 'message', data: 'plain' });
  });
});
