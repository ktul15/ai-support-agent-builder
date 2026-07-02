import type { PipelineOutput } from './scoring.js';

export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Reduce a chat SSE stream's frames into the final answer + done payload.
 * A `token` accumulates text; `done` carries grounded + citations; an `error`
 * frame marks the run as errored (so the harness can exclude it from the
 * quality metrics rather than mistaking it for an answer or a refusal).
 */
export function collectChat(frames: SseFrame[]): PipelineOutput {
  let answer = '';
  let grounded = false;
  let citations: { title: string }[] = [];
  let error = false;
  for (const f of frames) {
    if (f.event === 'token') {
      answer += (JSON.parse(f.data) as { text: string }).text;
    } else if (f.event === 'done') {
      const d = JSON.parse(f.data) as { grounded: boolean; citations?: { title: string }[] };
      grounded = d.grounded;
      citations = d.citations ?? [];
    } else if (f.event === 'error') {
      error = true;
    }
  }
  return { answer, grounded, citations, error };
}
