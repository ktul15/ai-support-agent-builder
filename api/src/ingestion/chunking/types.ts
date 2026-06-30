/** A chunk produced from a parsed document, ready for dedup (#16) + embed (#17). */
export interface ChunkDraft {
  /** What gets embedded: context header + overlap + body text. */
  content: string;
  /** The chunk's own body text (no header/overlap) — what charStart/charEnd span. */
  text: string;
  /** Page the chunk starts on (1 for paginationless formats). */
  page: number;
  /** Heading path at this point, e.g. "Refund Policy > Eligibility" (null if none). */
  section: string | null;
  /** Char offsets into the assembled document text (citation anchors). */
  charStart: number;
  charEnd: number;
  /** Token count of `content` (cl100k_base). */
  tokenCount: number;
}

export interface ChunkOptions {
  /**
   * Advisory lower bound. NOT enforced by merging across headings: break-on-
   * heading is hard (merging would skip the heading block and desync char
   * offsets), so a short section legitimately yields a sub-target chunk.
   */
  minTokens: number;
  /**
   * Target cap on the per-chunk body, measured as the SUM of per-block token
   * counts. BPE isn't additive across concatenation, so the joined text can run
   * a few separator-tokens over this — far below any embed limit, so it's an
   * approximate cap, not a hard ceiling.
   */
  maxTokens: number;
  /** Tokens of the previous chunk re-prepended for retrieval recall (same section). */
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  minTokens: 500,
  maxTokens: 800,
  overlapTokens: 100,
};
