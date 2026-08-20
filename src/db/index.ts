import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { Pool } from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

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

export const copyPool = new Pool({
  connectionString: config.db.url,
  max: 6,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

copyPool.on('error', (err) => {
  console.error('[copyPool] idle client error (connection discarded, pool continues):', err.message);
});