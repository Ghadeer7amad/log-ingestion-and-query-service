import { readDb } from './index.js';
import { sql } from 'drizzle-orm';
import { ValidatedLog } from '../validators/ingest.js';

// In-memory replacement for the read side of GET /logs/aggregate, for the
// common case: no `q` and no `attr.<key>` filter (exactly what the load
// generator's aggregate probe sends). Counts are kept at 1-minute
// granularity, keyed by (minute, service, level), and updated synchronously
// once a coalesced flush durably commits (see queries/ingestQueue.ts) --
// never before, so a count can never run ahead of what's actually been
// accepted.
//
// Why this exists, and why it's different from the rollup table tried
// earlier: that table proved query cost was never the problem -- even a
// 48-row, primary-key-indexed *Postgres* query still couldn't get scheduled
// under sustained write load, because reads can't reliably reach a
// CPU-saturated single Postgres core at all, regardless of how cheap the
// query is once it runs. This sidesteps that failure mode entirely: the
// read never touches Postgres, so it's never exposed to its contention. It
// uses the app's own CPU budget instead, which every measurement this
// session has shown sitting mostly idle.
//
// recordLogs() runs on every flush completion -- the hottest, most
// frequent path in the app -- so the write side avoids any per-row string
// allocation (a first version concatenated `service + sep + level` into a
// map key on every single row, which cost real throughput; a nested
// Map<service, Map<level, count>> needs no allocation beyond the first
// time a given service/level pair is seen). The occasional string built in
// queryAggregateCache() is fine -- that only runs once per aggregate
// request, not once per ingested row. Filtered queries (`q`/`attr.<key>`)
// still fall back to the raw-table scan in aggregate_logs.ts, since
// neither dimension is tracked here.

interface Bucket {
  counts: Map<string, Map<string, number>>; // service -> level -> count
}

const MINUTE_MS = 60_000;
const buckets: Map<number, Bucket> = new Map(); // key: minute-epoch (ms, UTC-truncated)

function minuteKeyOf(timestamp: Date): number {
  return Math.floor(timestamp.getTime() / MINUTE_MS) * MINUTE_MS;
}

function addToBucket(minuteStart: Date, service: string, level: string, delta: number): void {
  const key = minuteKeyOf(minuteStart);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { counts: new Map() };
    buckets.set(key, bucket);
  }
  let levelCounts = bucket.counts.get(service);
  if (!levelCounts) {
    levelCounts = new Map();
    bucket.counts.set(service, levelCounts);
  }
  levelCounts.set(level, (levelCounts.get(level) ?? 0) + delta);
}

export function recordLogs(logs: ValidatedLog[]): void {
  for (const log of logs) {
    addToBucket(log.timestamp, log.service, log.level, 1);
  }
}

export function pruneBucketsOlderThan(cutoff: Date): void {
  const cutoffKey = minuteKeyOf(cutoff);
  for (const key of buckets.keys()) {
    if (key < cutoffKey) buckets.delete(key);
  }
}

// One-time bootstrap at startup: primes the cache from whatever's already
// in Postgres (e.g. after a restart with existing data). Runs before the
// app reports healthy and before any traffic arrives, so -- consistent
// with the rollup-table finding -- there's no concurrent write pressure
// yet and this completes quickly even at ~1M rows.
export async function primeAggregateCacheFromDb(retentionDays: number): Promise<void> {
  const rows: any = await readDb.execute(sql`
    SELECT date_trunc('minute', timestamp) AS bucket_start, service, level, count(*) AS count
    FROM logs
    WHERE timestamp >= NOW() - make_interval(days => ${retentionDays})
    GROUP BY 1, 2, 3
  `);
  for (const row of rows) {
    addToBucket(new Date(row.bucket_start), row.service, row.level, Number(row.count));
  }
}

function truncateToBucket(epochMs: number, bucketSize: '1m' | '5m' | '1h' | '1d'): number {
  const d = new Date(epochMs);
  switch (bucketSize) {
    case '1m':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
    case '5m': {
      const epochSec = Math.floor(epochMs / 1000);
      return Math.floor(epochSec / 300) * 300 * 1000;
    }
    case '1h':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
    case '1d':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
}

export interface AggregateCacheParams {
  since: Date;
  until: Date;
  bucket: '1m' | '5m' | '1h' | '1d';
  group_by?: 'service' | 'level';
  service?: string;
  level?: string;
}

export interface AggregateCacheRow {
  start: Date;
  group: string | null;
  count: number;
}

export function queryAggregateCache(params: AggregateCacheParams): AggregateCacheRow[] {
  const { since, until, bucket, group_by, service: serviceFilter, level: levelFilter } = params;
  const sinceMs = since.getTime();
  const untilMs = until.getTime();

  const result = new Map<string, { start: number; group: string | null; count: number }>();

  for (const [minuteKey, bucketData] of buckets) {
    if (minuteKey < sinceMs || minuteKey >= untilMs) continue;

    const targetStart = truncateToBucket(minuteKey, bucket);

    // If a service filter is given, skip straight to that service's entry
    // instead of iterating every service in the bucket.
    const serviceEntries: IterableIterator<[string, Map<string, number>]> | [string, Map<string, number>][] =
      serviceFilter
        ? (bucketData.counts.has(serviceFilter) ? [[serviceFilter, bucketData.counts.get(serviceFilter)!]] : [])
        : bucketData.counts.entries();

    for (const [service, levelCounts] of serviceEntries) {
      for (const [level, count] of levelCounts) {
        if (levelFilter && level !== levelFilter) continue;

        const group = group_by === 'service' ? service : group_by === 'level' ? level : null;
        const resultKey = targetStart + '\0' + (group ?? '');

        const existing = result.get(resultKey);
        if (existing) {
          existing.count += count;
        } else {
          result.set(resultKey, { start: targetStart, group, count });
        }
      }
    }
  }

  return Array.from(result.values())
    .sort((a, b) => a.start - b.start || (a.group ?? '').localeCompare(b.group ?? ''))
    .map((r) => ({ start: new Date(r.start), group: r.group, count: r.count }));
}
