import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

export const queryClient = postgres(config.db.url, {
    max: 20,
    idle_timeout: 30, 
    connect_timeout: 10,
    prepare: false, 
});

export const db = drizzle(queryClient, { schema });