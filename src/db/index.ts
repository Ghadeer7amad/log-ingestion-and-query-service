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
export const writeClient = postgres(config.db.url, {
    max: 16,
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