import { insertLogsCopy } from './logs.js';
import { ValidatedLog } from '../../validators/ingest.js';

// Coalesces concurrent POST /logs requests' already-validated rows into
// fewer, larger INSERTs.
//
// Evidence this is necessary (not just theoretically nice): a rollup table
// with only ~48 rows and a primary-key-indexed query still couldn't get a
// response out inside 60s under sustained ingestion. That rules out query
// cost as the bottleneck -- it's OS-scheduler contention from having ~16-20
// concurrent Postgres backend processes fighting for one CPU core. Reducing
// the *number* of concurrently active write backends is the only lever
// left that can plausibly free up scheduling time for reads.
//
// A request's promise resolves only once its rows are part of a completed,
// successful flush -- never before and never on a failed flush -- so a 200
// is never returned for a batch that wasn't durably inserted.

interface PendingRequest {
  logs: ValidatedLog[];
  resolve: (acceptedCount: number) => void;
  reject: (err: Error) => void;
}

const FLUSH_INTERVAL_MS = 12;
const FLUSH_ROW_THRESHOLD = 5000;

let buffer: PendingRequest[] = [];
let bufferedRowCount = 0;
let flushTimer: NodeJS.Timeout | null = null;

export function enqueueLogsForInsert(validLogs: ValidatedLog[]): Promise<number> {
  return new Promise((resolve, reject) => {
    if (validLogs.length === 0) {
      resolve(0);
      return;
    }

    buffer.push({ logs: validLogs, resolve, reject });
    bufferedRowCount += validLogs.length;

    if (bufferedRowCount >= FLUSH_ROW_THRESHOLD) {
      flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
    }
  });
}

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return;

  const batch = buffer;
  buffer = [];
  bufferedRowCount = 0;

  const allLogs = batch.flatMap((req) => req.logs);

  insertLogsCopy(allLogs)
    .then(() => {
      for (const req of batch) req.resolve(req.logs.length);
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const req of batch) req.reject(error);
    });
}
