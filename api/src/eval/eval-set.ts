import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** An on-corpus question: the answer must contain every string in
 *  `expectedFacts` (case-insensitive substring) and be grounded in any one of
 *  `expectedDocs` (several facts live in more than one doc). */
export interface InCorpusCase {
  id: string;
  question: string;
  expectedFacts: string[];
  expectedDocs: string[];
  tags: string[];
}

/** An off-corpus question: the assistant must refuse rather than answer. */
export interface OffCorpusCase {
  id: string;
  question: string;
  reason: string;
  tags: string[];
}

export interface EvalSet {
  version: number;
  corpus: string;
  description: string;
  inCorpus: InCorpusCase[];
  offCorpus: OffCorpusCase[];
}

// The versioned data lives outside `src` (it is corpus + fixtures, not code).
// `../../eval` resolves to api/eval from both src/eval and dist/eval.
const HERE = dirname(fileURLToPath(import.meta.url));
export const EVAL_DATA_DIR = join(HERE, '..', '..', 'eval');
export const CORPUS_DIR = join(EVAL_DATA_DIR, 'corpus');
export const EVAL_SET_PATH = join(EVAL_DATA_DIR, 'eval-set.json');

/** Load and parse the eval set fixture. */
export function loadEvalSet(): EvalSet {
  return JSON.parse(readFileSync(EVAL_SET_PATH, 'utf8')) as EvalSet;
}
