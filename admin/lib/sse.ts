export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Incrementally parse SSE frames from a growing buffer. Returns the complete
 * frames found and the leftover partial text (carry it into the next chunk).
 * Used to consume a POST'd event-stream via fetch streaming (EventSource can't
 * POST). Keep-alive comment lines (starting `:`) are skipped.
 */
export function parseSseFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let idx: number;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    if (raw.startsWith(':')) continue; // heartbeat comment
    const event = /(?:^|\n)event: (.*)/.exec(raw)?.[1] ?? 'message';
    const data = /(?:^|\n)data: (.*)/.exec(raw)?.[1] ?? '';
    frames.push({ event, data });
  }
  return { frames, rest: buffer };
}
