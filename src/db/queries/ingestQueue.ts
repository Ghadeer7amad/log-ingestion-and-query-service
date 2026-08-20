import { insertLogsRaw } from './logs.js';
import { insertLogsCopy } from './copyInsert.js';
import { ValidatedBatch } from '../../validators/ingest.js';
import { recordLogs } from '../aggregateCache.js';
import { TooManyRequestsError } from '../../middlewares/errorHandler.js';
import { config } from '../../config.js';
import { yieldToEventLoop } from '../../utils/yieldToEventLoop.js';

const insertBatch = config.db.useCopyIngest ? insertLogsCopy : insertLogsRaw;

interface PendingRequest {
  batch: ValidatedBatch;
  resolve: (acceptedCount: number) => void;
  reject: (err: Error) => void;
}

const FLUSH_INTERVAL_MS = 12;
const FLUSH_ROW_THRESHOLD = 5000;

const MAX_OUTSTANDING_ROWS = 20000;
const RETRY_AFTER_SECONDS = 2;

let buffer: PendingRequest[] = [];
let bufferedRowCount = 0;
let outstandingRowCount = 0;
let flushTimer: NodeJS.Timeout | null = null;
let flushImmediate: NodeJS.Immediate | null = null;

const MERGE_YIELD_CHUNK_ROWS = 500;

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
      scheduleFlushImmediate();
    } else if (!flushTimer) {
      flushTimer = setTimeout(runFlush, FLUSH_INTERVAL_MS);
    }
  });
}

function runFlush(): void {
  flush().catch((err) => {
    console.error('[IngestQueue] Unexpected error in flush():', err);
  });
}

function scheduleFlushImmediate(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!flushImmediate) {
    flushImmediate = setImmediate(runFlush);
  }
}

async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushImmediate = null;
  if (buffer.length === 0) return;

  const pending = buffer;
  buffer = [];
  bufferedRowCount = 0;

  const totalCount = pending.reduce((sum, req) => sum + req.batch.count, 0);

  try {
    const timestamps: string[] = [];
    const timestampEpochs: number[] = [];
    const levels: string[] = [];
    const services: string[] = [];
    const messages: string[] = [];
    const attributesJson: string[] = [];
    let sinceYield = 0;

    for (const req of pending) {
      const b = req.batch;
      timestamps.push(...b.timestamps);
      timestampEpochs.push(...b.timestampEpochs);
      levels.push(...b.levels);
      services.push(...b.services);
      messages.push(...b.messages);
      attributesJson.push(...b.attributesJson);

      sinceYield += b.count;
      if (sinceYield >= MERGE_YIELD_CHUNK_ROWS) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }

    insertBatch({ timestamps, levels, services, messages, attributesJson })
      .then(() => {
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
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const req of pending) req.reject(error);
    outstandingRowCount -= totalCount;
  }
}
