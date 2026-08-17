import { readDb } from './index.js';
import { sql } from 'drizzle-orm';

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
//
// Hierarchical rollups (added to fix README Section 10's documented weak
// spot: cache read cost scales with the number of *stored* buckets inside
// the requested window, not with total row count -- a 15-day/1h-bucket
// query measured 1.53s because it had to iterate ~21,600 minute buckets to
// answer a request that only needed ~360 numbers). Every ingested row is
// now folded into three parallel Maps -- minute, hour, and day -- at
// negligible extra cost (two more Map lookups per row, no extra
// allocation beyond the first time a given bucket/service/level triple is
// seen, same as the existing minute map). queryAggregateCache() then reads
// from the coarsest map that evenly divides the request: for a '1h' or
// '1d' bucket request, the *interior* of [since, until) that aligns exactly
// to hour/day boundaries is answered directly from the hour/day map
// (O(hours) or O(days) instead of O(minutes)); only the leftover partial
// hour/day at each edge of the window (at most one bucket-width on each
// side) falls back to scanning the minute map, same as before. This is
// exact -- it never double-counts or drops rows -- because the aligned
// interior and the two edges are disjoint, and rows in the aligned interior
// come from a map that was updated with the exact same rows as the minute
// map, just pre-summed at a coarser key. '1m'/'5m' requests are unaffected
// and still always read the minute map, since neither is a case the
// evidence showed was slow.
//
// One accepted trade-off, worth being explicit about: pruning (below) can
// leave a *bounded* amount of expired data inside an hour/day bucket that
// straddles the retention cutoff, until the next retention cycle's cutoff
// moves past that bucket entirely (see pruneBucketsOlderThan). This widens
// -- but does not newly introduce -- the same imprecision the original
// minute-only design already had at 1-minute width (a minute bucket
// straddling the exact cutoff instant was never partially trimmed either,
// only ever kept whole or deleted whole). Self-heals every retention run;
// only affects aggregate queries reaching back past the retention window's
// edge.

interface Bucket {
  counts: Map<string, Map<string, number>>; // service -> level -> count
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

let minuteBuckets: Map<number, Bucket> = new Map(); // key: minute-epoch (ms, UTC-truncated)
let hourBuckets: Map<number, Bucket> = new Map(); // key: hour-epoch (ms, UTC-truncated)
let dayBuckets: Map<number, Bucket> = new Map(); // key: day-epoch (ms, UTC-truncated)

// Test-only: the module holds its state at module scope (deliberately --
// it's a process-lifetime cache, not a per-request object), which unit
// tests need to reset between cases for isolation. Not called from
// anywhere in the running app.
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

// Folds one row's count into all three granularities at once. Called from
// both the hot ingest path (recordLogs) and the one-time startup backfill
// (primeAggregateCacheFromDb) so the three maps can never drift apart --
// there is no code path that updates one without the others.
function addToBucket(epochMs: number, service: string, level: string, delta: number): void {
  addToMap(minuteBuckets, minuteKeyOf(epochMs), service, level, delta);
  addToMap(hourBuckets, hourKeyOf(epochMs), service, level, delta);
  addToMap(dayBuckets, dayKeyOf(epochMs), service, level, delta);
}

// Takes parallel arrays (epoch ms, service, level), not objects -- callers
// (ingestQueue.ts's flush()) already have these as arrays from validation,
// which no longer constructs a Date anywhere in the ingest hot path. Taking
// epoch numbers here instead of Date objects means this hottest, most
// frequent function in the app allocates nothing per call beyond what the
// Map/Map nesting already needs the first time a given bucket/service/level
// combination is seen.
export function recordLogs(count: number, timestampEpochs: number[], services: string[], levels: string[]): void {
  for (let i = 0; i < count; i++) {
    addToBucket(timestampEpochs[i], services[i], levels[i], 1);
  }
}

// Only deletes a bucket once its entire span has passed the cutoff (key +
// its own width <= cutoff) -- never a bucket that still holds any
// non-expired data. A bucket whose span straddles the cutoff is kept in
// full (see the module-level comment above for the resulting, bounded,
// self-healing imprecision this implies for hour/day buckets specifically).
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

// Scans a bucket map (whatever its native granularity is) for keys inside
// [sinceMs, untilMs), re-buckets each into the caller's requested
// `bucket` size, and accumulates into `result`. Used both for the plain
// minute-map scan (the original, always-correct path) and, when reading
// directly from the hour/day maps, for windows that are already aligned to
// that map's native width -- in that case targetStart === key, so this is
// just a pass-through sum, not a re-bucketing.
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

    // If a service filter is given, skip straight to that service's entry
    // instead of iterating every service in the bucket.
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

  // Only '1h'/'1d' requests have a native coarse map to read from -- '1m'
  // and '5m' were never the slow case (README Section 10 only measured a
  // wide 1h-bucket window as over target), so they keep scanning the
  // minute map exactly as before.
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
      // Interior: full aligned buckets, read straight from the coarse map.
      scanMapInto(coarse.map, alignedSince, alignedUntil, bucket, group_by, serviceFilter, levelFilter, result);
      // Edges: whatever's left on either side is less than one bucket-width
      // and isn't guaranteed to align to anything -- fall back to the
      // always-correct minute map for just those slivers.
      if (sinceMs < alignedSince) {
        scanMapInto(minuteBuckets, sinceMs, alignedSince, bucket, group_by, serviceFilter, levelFilter, result);
      }
      if (alignedUntil < untilMs) {
        scanMapInto(minuteBuckets, alignedUntil, untilMs, bucket, group_by, serviceFilter, levelFilter, result);
      }
    } else {
      // Window is narrower than one bucket-width, or doesn't contain a
      // full aligned bucket -- no interior to speed up, scan minute map.
      scanMapInto(minuteBuckets, sinceMs, untilMs, bucket, group_by, serviceFilter, levelFilter, result);
    }
  } else {
    scanMapInto(minuteBuckets, sinceMs, untilMs, bucket, group_by, serviceFilter, levelFilter, result);
  }

  return Array.from(result.values())
    .sort((a, b) => a.start - b.start || (a.group ?? '').localeCompare(b.group ?? ''))
    .map((r) => ({ start: new Date(r.start), group: r.group, count: r.count }));
}
