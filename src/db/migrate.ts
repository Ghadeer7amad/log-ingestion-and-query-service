import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from './index';

export async function runMigrations() {
    console.log('Running database migrations...');
    try {
      await migrate(db, { migrationsFolder: './src/db/migrations' });
      console.log('Migrations applied successfully!');

    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
    
}