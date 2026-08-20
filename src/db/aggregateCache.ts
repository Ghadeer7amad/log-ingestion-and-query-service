import { readDb } from './index.js';
import { sql } from 'drizzle-orm';

interface Bucket {
  counts: Map<string, Map<string, number>>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

let minuteBuckets: Map<number, Bucket> = new Map();
let hourBuckets: Map<number, Bucket> = new Map();
let dayBuckets: Map<number, Bucket> = new Map();

export function __resetForTesting(): void {
  minuteBuckets = new Map();
  hourBuckets = new Map();
  dayBuckets = new Map();
}

function minuteKeyOf(epochMs: number): number {
  return Math.floor(epochMs / MINUTE_MS) * MINUTE_MS;
}

function hourKeyOf(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS;
}

function dayKeyOf(epochMs: number): number {
  return Math.floor(epochMs / DAY_MS) * DAY_MS;
}

function addToMap(map: Map<number, Bucket>, key: number, service: string, level: string, delta: number): void {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { counts: new Map() };
    map.set(key, bucket);
  }
  let levelCounts = bucket.counts.get(service);
  if (!levelCounts) {
    levelCounts = new Map();
    bucket.counts.set(service, levelCounts);
  }
  levelCounts.set(level, (levelCounts.get(level) ?? 0) + delta);
}

function addToBucket(epochMs: number, service: string, level: string, delta: number): void {
  addToMap(minuteBuckets, minuteKeyOf(epochMs), service, level, delta);
  addToMap(hourBuckets, hourKeyOf(epochMs), service, level, delta);
  addToMap(dayBuckets, dayKeyOf(epochMs), service, level, delta);
}

export function recordLogs(count: number, timestampEpochs: number[], services: string[], levels: string[]): void {
  for (let i = 0; i < count; i++) {
    addToBucket(timestampEpochs[i], services[i], levels[i], 1);
  }
}

function pruneMapOlderThan(map: Map<number, Bucket>, widthMs: number, cutoffMs: number): void {
  for (const key of map.keys()) {
    if (key + widthMs <= cutoffMs) map.delete(key);
  }
}

export function pruneBucketsOlderThan(cutoff: Date): void {
  const cutoffMs = cutoff.getTime();
  pruneMapOlderThan(minuteBuckets, MINUTE_MS, cutoffMs);
  pruneMapOlderThan(hourBuckets, HOUR_MS, cutoffMs);
  pruneMapOlderThan(dayBuckets, DAY_MS, cutoffMs);
}

export async function primeAggregateCacheFromDb(retentionDays: number): Promise<void> {
  const rows: any = await readDb.execute(sql`
    SELECT date_trunc('minute', timestamp) AS bucket_start, service, level, count(*) AS count
    FROM logs
    WHERE timestamp >= NOW() - make_interval(days => ${retentionDays})
    GROUP BY 1, 2, 3
  `);
  for (const row of rows) {
    addToBucket(new Date(row.bucket_start).getTime(), row.service, row.level, Number(row.count));
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

type ResultAccumulator = Map<string, { start: number; group: string | null; count: number }>;

function scanMapInto(
  map: Map<number, Bucket>,
  sinceMs: number,
  untilMs: number,
  bucket: '1m' | '5m' | '1h' | '1d',
  group_by: 'service' | 'level' | undefined,
  serviceFilter: string | undefined,
  levelFilter: string | undefined,
  result: ResultAccumulator
): void {
  for (const [key, bucketData] of map) {
    if (key < sinceMs || key >= untilMs) continue;

    const targetStart = truncateToBucket(key, bucket);

    const serviceEntries: IterableIterator<[string, Map<string, number>]> | [string, Map<string, number>][] =
      serviceFilter
        ? bucketData.counts.has(serviceFilter)
          ? [[serviceFilter, bucketData.counts.get(serviceFilter)!]]
          : []
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
}

export function queryAggregateCache(params: AggregateCacheParams): AggregateCacheRow[] {
  const { since, until, bucket, group_by, service: serviceFilter, level: levelFilter } = params;
  const sinceMs = since.getTime();
  const untilMs = until.getTime();

  const result: ResultAccumulator = new Map();

  const coarse =
    bucket === '1h'
      ? { map: hourBuckets, widthMs: HOUR_MS }
      : bucket === '1d'
        ? { map: dayBuckets, widthMs: DAY_MS }
        : null;

  if (coarse) {
    const alignedSince = Math.ceil(sinceMs / coarse.widthMs) * coarse.widthMs;
    const alignedUntil = Math.floor(untilMs / coarse.widthMs) * coarse.widthMs;

    if (alignedSince < alignedUntil) {
      scanMapInto(coarse.map, alignedSince, alignedUntil, bucket, group_by, serviceFilter, levelFilter, result);
      if (sinceMs < alignedSince) {
        scanMapInto(minuteBuckets, sinceMs, alignedSince, bucket, group_by, serviceFilter, levelFilter, result);
      }
      if (alignedUntil < untilMs) {
        scanMapInto(minuteBuckets, alignedUntil, untilMs, bucket, group_by, serviceFilter, levelFilter, result);
      }
    } else {
      scanMapInto(minuteBuckets, sinceMs, untilMs, bucket, group_by, serviceFilter, levelFilter, result);
    }
  } else {
    scanMapInto(minuteBuckets, sinceMs, untilMs, bucket, group_by, serviceFilter, levelFilter, result);
  }

  return Array.from(result.values())
    .sort((a, b) => a.start - b.start || (a.group ?? '').localeCompare(b.group ?? ''))
    .map((r) => ({ start: new Date(r.start), group: r.group, count: r.count }));
}
