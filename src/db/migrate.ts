import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';

export async function runMigrations(): Promise<void> {
  const migrationClient = postgres(config.db.url, { 
    max: 1,
    idle_timeout: 1, 
    connect_timeout: 5,
  });
  
  try {
    const migrationDb = drizzle(migrationClient);
    await migrate(migrationDb, {
      migrationsFolder: './src/db/migrations',
    });
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await migrationClient.end();
  }
}