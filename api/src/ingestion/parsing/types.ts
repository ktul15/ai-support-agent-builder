/** A structural segment emitted by a format parser (pre char-offset). */
export interface RawBlock {
  text: string;
  /** 1-based page number (1 for paginationless formats: TXT/MD/DOCX). */
  page: number;
  heading?: boolean;
  /** Heading depth (1-6) when `heading` is true. */
  level?: number;
}

/** A block with its char offsets into the assembled normalized text. */
export interface AnchoredBlock extends RawBlock {
  charStart: number;
  charEnd: number;
}

/** Raw output of a per-format parser, before assembly. */
export interface FormatParseResult {
  blocks: RawBlock[];
  pageCount: number;
  /** Human-readable issues (e.g. low-text/scanned pages). Non-fatal. */
  warnings: string[];
}

/** Normalized, structured document ready for chunking (#15). */
export interface ParsedDocument {
  /** Full normalized text; block offsets index into this. */
  text: string;
  pageCount: number;
  warnings: string[];
  blocks: AnchoredBlock[];
}

/** Thrown when content can't be parsed or doesn't match its declared type. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}
