import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config';
import * as schema from './schema';

export const queryClient = postgres(config.db.url, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });