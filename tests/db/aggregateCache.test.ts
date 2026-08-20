import { describe, it, expect, beforeEach } from 'vitest';
import { recordLogs, queryAggregateCache, pruneBucketsOlderThan, __resetForTesting } from './aggregateCache.js';

// recordLogs now takes parallel arrays (epoch ms, service, level), not
// objects -- this helper keeps tests reading like a list of log overrides
// while building the arrays underneath.
function record(logs: Array<{ timestamp?: Date; service?: string; level?: string }>): void {
  const defaults = { timestamp: new Date('2026-08-15T10:00:00.000Z'), service: 'checkout', level: 'error' };
  const merged = logs.map((o) => ({ ...defaults, ...o }));
  recordLogs(
    merged.length,
    merged.map((l) => l.timestamp.getTime()),
    merged.map((l) => l.service),
    merged.map((l) => l.level)
  );
}

beforeEach(() => {
  __resetForTesting();
});

describe('aggregateCache', () => {
  it('returns nothing for a range with no recorded logs', () => {
    const result = queryAggregateCache({
      since: new Date('2026-08-15T00:00:00.000Z'),
      until: new Date('2026-08-16T00:00:00.000Z'),
      bucket: '1m',
    });
    expect(result).toEqual([]);
  });

  it('counts logs correctly with no group_by (total per bucket, group null)', () => {
    record([
      { service: 'checkout', level: 'error' },
      { service: 'auth', level: 'info' },
      { service: 'auth', level: 'info' },
    ]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T09:00:00.000Z'),
      until: new Date('2026-08-15T11:00:00.000Z'),
      bucket: '1m',
    });

    expect(result).toEqual([
      { start: new Date('2026-08-15T10:00:00.000Z'), group: null, count: 3 },
    ]);
  });

  it('groups by service correctly', () => {
    record([
      { service: 'checkout' },
      { service: 'checkout' },
      { service: 'auth' },
    ]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T09:00:00.000Z'),
      until: new Date('2026-08-15T11:00:00.000Z'),
      bucket: '1m',
      group_by: 'service',
    });

    const byGroup = Object.fromEntries(result.map((r) => [r.group, r.count]));
    expect(byGroup).toEqual({ checkout: 2, auth: 1 });
  });

  it('groups by level correctly', () => {
    record([
      { level: 'error' },
      { level: 'error' },
      { level: 'warn' },
    ]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T09:00:00.000Z'),
      until: new Date('2026-08-15T11:00:00.000Z'),
      bucket: '1m',
      group_by: 'level',
    });

    const byGroup = Object.fromEntries(result.map((r) => [r.group, r.count]));
    expect(byGroup).toEqual({ error: 2, warn: 1 });
  });

  it('filters by service', () => {
    record([{ service: 'checkout' }, { service: 'auth' }]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T09:00:00.000Z'),
      until: new Date('2026-08-15T11:00:00.000Z'),
      bucket: '1m',
      service: 'checkout',
    });

    expect(result).toEqual([
      { start: new Date('2026-08-15T10:00:00.000Z'), group: null, count: 1 },
    ]);
  });

  it('filters by level', () => {
    record([{ level: 'error' }, { level: 'warn' }]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T09:00:00.000Z'),
      until: new Date('2026-08-15T11:00:00.000Z'),
      bucket: '1m',
      level: 'error',
    });

    expect(result).toEqual([
      { start: new Date('2026-08-15T10:00:00.000Z'), group: null, count: 1 },
    ]);
  });

  it('excludes logs outside the [since, until) range -- since inclusive, until exclusive', () => {
    record([
      { timestamp: new Date('2026-08-15T09:59:00.000Z') }, // just before window
      { timestamp: new Date('2026-08-15T10:00:00.000Z') }, // exactly at since (inclusive)
      { timestamp: new Date('2026-08-15T10:59:00.000Z') }, // inside window
      { timestamp: new Date('2026-08-15T11:00:00.000Z') }, // exactly at until (exclusive)
    ]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T10:00:00.000Z'),
      until: new Date('2026-08-15T11:00:00.000Z'),
      bucket: '1h',
    });

    const total = result.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(2); // the 10:00:00 and 10:59:00 entries only
  });

  it('re-buckets correctly into 5m/1h/1d without double counting or losing rows', () => {
    record([
      { timestamp: new Date('2026-08-15T10:02:00.000Z') },
      { timestamp: new Date('2026-08-15T10:04:00.000Z') },
      { timestamp: new Date('2026-08-15T10:07:00.000Z') },
    ]);

    const fiveMin = queryAggregateCache({
      since: new Date('2026-08-15T10:00:00.000Z'),
      until: new Date('2026-08-15T10:10:00.000Z'),
      bucket: '5m',
    });
    expect(fiveMin.reduce((s, r) => s + r.count, 0)).toBe(3);
    expect(fiveMin.find((r) => r.start.getTime() === new Date('2026-08-15T10:00:00.000Z').getTime())?.count).toBe(2);
    expect(fiveMin.find((r) => r.start.getTime() === new Date('2026-08-15T10:05:00.000Z').getTime())?.count).toBe(1);

    const hourly = queryAggregateCache({
      since: new Date('2026-08-15T10:00:00.000Z'),
      until: new Date('2026-08-15T11:00:00.000Z'),
      bucket: '1h',
    });
    expect(hourly).toEqual([
      { start: new Date('2026-08-15T10:00:00.000Z'), group: null, count: 3 },
    ]);
  });

  it('results are sorted by bucket start ascending', () => {
    record([
      { timestamp: new Date('2026-08-15T12:00:00.000Z') },
      { timestamp: new Date('2026-08-15T10:00:00.000Z') },
      { timestamp: new Date('2026-08-15T11:00:00.000Z') },
    ]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T09:00:00.000Z'),
      until: new Date('2026-08-15T13:00:00.000Z'),
      bucket: '1h',
    });

    const starts = result.map((r) => r.start.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('pruneBucketsOlderThan removes only buckets before the cutoff', () => {
    record([
      { timestamp: new Date('2026-07-01T00:00:00.000Z') }, // old
      { timestamp: new Date('2026-08-15T10:00:00.000Z') }, // recent
    ]);

    pruneBucketsOlderThan(new Date('2026-08-01T00:00:00.000Z'));

    const result = queryAggregateCache({
      since: new Date('2026-01-01T00:00:00.000Z'),
      until: new Date('2026-12-31T00:00:00.000Z'),
      bucket: '1d',
    });

    expect(result.reduce((s, r) => s + r.count, 0)).toBe(1);
  });

  it('recordLogs with count=0 is a no-op', () => {
    recordLogs(0, [], [], []);
    const result = queryAggregateCache({
      since: new Date('2026-01-01T00:00:00.000Z'),
      until: new Date('2026-12-31T00:00:00.000Z'),
      bucket: '1d',
    });
    expect(result).toEqual([]);
  });

  // --- Hierarchical rollups (hour/day maps used for '1h'/'1d' requests) ---

  it('1h bucket over a window aligned exactly to hour boundaries matches the minute-map answer', () => {
    record([
      { timestamp: new Date('2026-08-15T10:00:00.000Z') },
      { timestamp: new Date('2026-08-15T10:30:00.000Z') },
      { timestamp: new Date('2026-08-15T11:45:00.000Z') },
      { timestamp: new Date('2026-08-15T12:59:00.000Z') },
    ]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T10:00:00.000Z'),
      until: new Date('2026-08-15T13:00:00.000Z'),
      bucket: '1h',
    });

    expect(result).toEqual([
      { start: new Date('2026-08-15T10:00:00.000Z'), group: null, count: 2 },
      { start: new Date('2026-08-15T11:00:00.000Z'), group: null, count: 1 },
      { start: new Date('2026-08-15T12:00:00.000Z'), group: null, count: 1 },
    ]);
  });

  it('1h bucket over a window with unaligned edges still counts every row exactly once', () => {
    record([
      { timestamp: new Date('2026-08-15T09:50:00.000Z') }, // in the pre-edge sliver
      { timestamp: new Date('2026-08-15T10:00:00.000Z') }, // first full aligned hour
      { timestamp: new Date('2026-08-15T10:59:00.000Z') }, // still first full aligned hour
      { timestamp: new Date('2026-08-15T11:00:00.000Z') }, // second full aligned hour
      { timestamp: new Date('2026-08-15T12:10:00.000Z') }, // in the post-edge sliver
    ]);

    // Window: 09:45 -> 12:20, i.e. neither edge lands on an hour boundary.
    const result = queryAggregateCache({
      since: new Date('2026-08-15T09:45:00.000Z'),
      until: new Date('2026-08-15T12:20:00.000Z'),
      bucket: '1h',
    });

    const total = result.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(5); // every row counted, none dropped, none doubled

    const byStart = Object.fromEntries(result.map((r) => [r.start.toISOString(), r.count]));
    expect(byStart).toEqual({
      '2026-08-15T09:00:00.000Z': 1, // pre-edge sliver re-bucketed to its containing hour
      '2026-08-15T10:00:00.000Z': 2, // full aligned hour, read from the hour map
      '2026-08-15T11:00:00.000Z': 1, // full aligned hour, read from the hour map
      '2026-08-15T12:00:00.000Z': 1, // post-edge sliver re-bucketed to its containing hour
    });
  });

  it('1d bucket correctly sums a multi-day window via the day map', () => {
    record([
      { timestamp: new Date('2026-08-10T23:59:00.000Z') },
      { timestamp: new Date('2026-08-11T00:00:00.000Z') },
      { timestamp: new Date('2026-08-11T12:00:00.000Z') },
      { timestamp: new Date('2026-08-12T05:00:00.000Z') },
    ]);

    const result = queryAggregateCache({
      since: new Date('2026-08-11T00:00:00.000Z'),
      until: new Date('2026-08-13T00:00:00.000Z'),
      bucket: '1d',
    });

    expect(result).toEqual([
      { start: new Date('2026-08-11T00:00:00.000Z'), group: null, count: 2 },
      { start: new Date('2026-08-12T00:00:00.000Z'), group: null, count: 1 },
    ]);
  });

  it('1h bucket with group_by/service/level filters agrees on the aligned interior and the edges', () => {
    record([
      { timestamp: new Date('2026-08-15T09:50:00.000Z'), service: 'auth', level: 'error' },
      { timestamp: new Date('2026-08-15T10:05:00.000Z'), service: 'auth', level: 'error' },
      { timestamp: new Date('2026-08-15T10:10:00.000Z'), service: 'checkout', level: 'error' },
      { timestamp: new Date('2026-08-15T10:20:00.000Z'), service: 'auth', level: 'warn' },
    ]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T09:45:00.000Z'),
      until: new Date('2026-08-15T11:00:00.000Z'),
      bucket: '1h',
      group_by: 'service',
      service: 'auth',
      level: 'error',
    });

    const total = result.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(2); // the two auth/error rows only -- checkout and warn excluded
  });

  it('a window narrower than one hour still falls back to the minute map correctly', () => {
    record([
      { timestamp: new Date('2026-08-15T10:10:00.000Z') },
      { timestamp: new Date('2026-08-15T10:40:00.000Z') },
    ]);

    const result = queryAggregateCache({
      since: new Date('2026-08-15T10:05:00.000Z'),
      until: new Date('2026-08-15T10:45:00.000Z'),
      bucket: '1h',
    });

    expect(result.reduce((s, r) => s + r.count, 0)).toBe(2);
  });

  it('pruneBucketsOlderThan only evicts hour/day buckets whose entire span is expired', () => {
    record([
      { timestamp: new Date('2026-07-01T10:00:00.000Z') }, // wholly expired hour/day
      { timestamp: new Date('2026-08-15T23:30:00.000Z') }, // hour/day bucket straddles the cutoff below
      { timestamp: new Date('2026-08-16T10:00:00.000Z') }, // clearly still fresh
    ]);

    // Cutoff lands inside the 2026-08-15T23:00 hour / 2026-08-15 day bucket.
    pruneBucketsOlderThan(new Date('2026-08-15T23:45:00.000Z'));

    const dayResult = queryAggregateCache({
      since: new Date('2026-01-01T00:00:00.000Z'),
      until: new Date('2026-12-31T00:00:00.000Z'),
      bucket: '1d',
    });
    // The wholly-expired 2026-07-01 row is gone; the straddling bucket (with
    // its one row) and the fresh row both remain -- straddling buckets are
    // never partially trimmed, only ever evicted once entirely expired.
    expect(dayResult.reduce((s, r) => s + r.count, 0)).toBe(2);
  });
});
