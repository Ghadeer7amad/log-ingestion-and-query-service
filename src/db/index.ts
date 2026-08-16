import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { Pool } from 'pg';
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

// Separate `pg` pool, used only by the experimental COPY write path
// (queries/copyInsert.ts). `pg-copy-streams` needs a raw `pg.Client`, not a
// `postgres.js` connection -- COPY's streaming wire sub-protocol isn't
// something postgres.js exposes a stable API for (the crash history in
// this project's own COPY attempt was specifically inside postgres.js's
// stream handling). Deliberately isolated from `writeClient`: this pool
// existing or misbehaving must never be able to affect the UNNEST path
// while COPY is behind a flag and unproven under load.
export const copyPool = new Pool({
  connectionString: config.db.url,
  max: 6,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Required by `pg`'s own documented contract, not an app-level workaround:
// unlike postgres.js, `pg.Pool` does not handle a *idle* client losing its
// server-side connection internally -- if a pooled-but-currently-unused
// client gets closed by Postgres (server restart, admin command, or in
// this project's own crash-safety testing, pg_terminate_backend hitting a
// connection sitting idle between flushes because pg_stat_activity's
// `query` column still shows a connection's last-run COPY even once it's
// idle again), the pool re-emits that as an 'error' event on itself. With
// no listener, Node treats that as an unhandled 'error' event and crashes
// the process -- confirmed directly this session (pg-pool/index.js's
// idleListener, `FATAL: terminating connection due to administrator
// command`, code 57P01). This listener only discards a bad idle
// connection so the pool can open a fresh one next time it's needed; it
// does not touch, retry, or affect any in-flight query -- narrowly scoped
// to the one failure mode `pg.Pool`'s own docs say requires this, not a
// blanket exception suppressor for the process.
copyPool.on('error', (err) => {
  console.error('[copyPool] idle client error (connection discarded, pool continues):', err.message);
});