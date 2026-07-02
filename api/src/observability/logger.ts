export type LogFields = Record<string, unknown>;

/** Structured, level-tagged event logging. One JSON object per line. */
export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => process.stdout.write(`${line}\n`);

/**
 * A dependency-free JSON-lines logger. Each call emits
 * `{"level","time","event",...fields}` so logs are grep/aggregation friendly
 * (a collector sums the usage events per tenant — the basis for metering/billing
 * in #52). `sink`/`now` are injectable for tests.
 */
export function createLogger(
  sink: LogSink = defaultSink,
  now: () => string = () => new Date().toISOString(),
): Logger {
  const emit =
    (level: 'info' | 'warn' | 'error') =>
    (event: string, fields: LogFields = {}): void => {
      sink(JSON.stringify({ level, time: now(), event, ...fields }));
    };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** A logger that drops everything — for tests/contexts that shouldn't emit. */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
