import { insertLogsRaw } from './logs.js';
import { ValidatedBatch } from '../../validators/ingest.js';
import { recordLogs } from '../aggregateCache.js';
import { TooManyRequestsError } from '../../middlewares/errorHandler.js';

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
  batch: ValidatedBatch;
  resolve: (acceptedCount: number) => void;
  reject: (err: Error) => void;
}

const FLUSH_INTERVAL_MS = 12;
const FLUSH_ROW_THRESHOLD = 5000;

// Load shedding: reject new batches with 429 instead of letting them queue
// indefinitely once too much accepted-but-not-yet-durable work is
// outstanding. Deliberately NOT the same thing as `bufferedRowCount` below
// -- that counter resets to 0 the instant a flush is *called*, even though
// flush() doesn't wait for insertLogsRaw() to resolve before returning. If
// Postgres is slow, several flushes can be stuck in flight at once while
// bufferedRowCount sits near zero the whole time, making it a false "queue
// looks fine" signal during exactly the overload this is meant to catch.
// outstandingRowCount instead counts every row from the moment its request
// is accepted into the queue until its batch's flush actually resolves or
// rejects, across all in-flight flushes -- the real measure of backlog.
//
// Threshold picked from measured reality, not a guess: this system sustains
// ~4,400 logs/sec at the 1000ms CFS period (README Section 9) under the
// hardest tested combined load. 20,000 rows is ~4.5s of headroom above that
// -- enough to absorb a genuine short burst without shedding it, short
// enough that a client isn't left hanging toward the old 60s timeout once
// the system is genuinely overloaded rather than just momentarily busy.
// Validate/tune against load-tests/load-test-portal.js: zero 429s expected
// during the "load" scenario at a passing rate, 429s (not 60s hangs)
// expected once "stress"/"spike"/"breakpoint" genuinely overload the queue.
const MAX_OUTSTANDING_ROWS = 20000;
const RETRY_AFTER_SECONDS = 2;

let buffer: PendingRequest[] = [];
let bufferedRowCount = 0;
let outstandingRowCount = 0;
let flushTimer: NodeJS.Timeout | null = null;

export function enqueueLogsForInsert(batch: ValidatedBatch): Promise<number> {
  return new Promise((resolve, reject) => {
    if (batch.count === 0) {
      resolve(0);
      return;
    }

    if (outstandingRowCount + batch.count > MAX_OUTSTANDING_ROWS) {
      reject(
        new TooManyRequestsError(
          'Server is overloaded -- write queue is backed up beyond capacity. Retry shortly.',
          RETRY_AFTER_SECONDS
        )
      );
      return;
    }

    outstandingRowCount += batch.count;
    buffer.push({ batch, resolve, reject });
    bufferedRowCount += batch.count;

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

  const pending = buffer;
  buffer = [];
  bufferedRowCount = 0;

  // Merge every pending request's already-built arrays into one combined
  // set for the coalesced INSERT. This is array concatenation of strings
  // and numbers, not object allocation -- coalescing many requests into
  // one flush still costs almost nothing extra here, which is the whole
  // point: validation already did the only per-log work that matters.
  const timestamps: string[] = [];
  const timestampEpochs: number[] = [];
  const levels: string[] = [];
  const services: string[] = [];
  const messages: string[] = [];
  const attributesJson: string[] = [];
  let totalCount = 0;

  for (const req of pending) {
    const b = req.batch;
    timestamps.push(...b.timestamps);
    timestampEpochs.push(...b.timestampEpochs);
    levels.push(...b.levels);
    services.push(...b.services);
    messages.push(...b.messages);
    attributesJson.push(...b.attributesJson);
    totalCount += b.count;
  }

  insertLogsRaw({ timestamps, levels, services, messages, attributesJson })
    .then(() => {
      // Only count rows toward the in-memory aggregate cache once they're
      // confirmed durably written -- same discipline as resolving each
      // request's promise below, never before.
      recordLogs(totalCount, timestampEpochs, services, levels);
      for (const req of pending) req.resolve(req.batch.count);
    })
    .catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const req of pending) req.reject(error);
    })
    .finally(() => {
      outstandingRowCount -= totalCount;
    });
}
