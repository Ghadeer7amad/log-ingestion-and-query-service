import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

// Two independent connection pools so sustained ingestion (POST /logs) can
// never starve out read traffic (GET /logs, GET /logs/aggregate) of a
// connection. Previously both paths shared one `max: 8` pool: under
// sustained ingestion all 8 connections stayed busy with INSERTs, so every
// read request queued behind them in postgres.js's internal queue -- this
// measured as ~80% aggregate failures / p95 near the request timeout during
// a combined 120s ingestion+aggregate load test.
//
// max is deliberately small (was 16): on a single-CPU Postgres container,
// more concurrent write backends doesn't mean more throughput past the core
// count -- it was proven (five separate load tests, including one against a
// 48-row rollup table with a trivial query) to mean more OS-scheduler
// contention, starving read backends of CPU time regardless of how cheap
// their query is. Paired with write coalescing (see
// queries/ingestQueue.ts), which converts many small concurrent inserts
// into far fewer, larger ones, so this pool rarely needs more than a
// couple of connections active at once anyway.
export const writeClient = postgres(config.db.url, {
    max: 6,
    idle_timeout: 30,
    connect_timeout: 10,
});

export const readClient = postgres(config.db.url, {
    max: 4,
    idle_timeout: 30,
    connect_timeout: 10,
});

export const writeDb = drizzle(writeClient, { schema });
export const readDb = drizzle(readClient, { schema });