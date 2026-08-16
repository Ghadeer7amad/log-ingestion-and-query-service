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
});
