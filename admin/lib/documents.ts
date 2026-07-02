export type IngestStatus = 'UPLOADED' | 'PARSING' | 'EMBEDDING' | 'READY' | 'FAILED';

/** Ordered ingestion stages (FAILED is terminal but off the happy path). */
export const INGEST_STEPS: IngestStatus[] = ['UPLOADED', 'PARSING', 'EMBEDDING', 'READY'];

const STATUS_LABELS: Record<IngestStatus, string> = {
  UPLOADED: 'Uploaded',
  PARSING: 'Parsing…',
  EMBEDDING: 'Embedding…',
  READY: 'Ready',
  FAILED: 'Failed',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as IngestStatus] ?? status;
}

/** READY or FAILED — the stream ends and no further progress is expected. */
export function isTerminalStatus(status: string): boolean {
  return status === 'READY' || status === 'FAILED';
}

/** Index of a status in the happy-path steps (-1 for FAILED/unknown). */
export function stepIndex(status: string): number {
  return INGEST_STEPS.indexOf(status as IngestStatus);
}
