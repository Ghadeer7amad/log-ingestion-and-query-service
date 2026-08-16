import type { MigrationConfig } from "drizzle-orm/migrator";
import fs from "node:fs";

if (fs.existsSync(".env")) {
  process.loadEnvFile();
}

export type APIConfig = {
  port: number;
  apiKey: string;
};

export type DBConfig = {
  url: string;
  migrationConfig: MigrationConfig;
  retentionDays: number;
  // Feature flag for the experimental COPY-based write path
  // (queries/copyInsert.ts), off by default. This project already had one
  // COPY implementation (via postgres.js) that measured better than
  // UNNEST and then crashed under sustained load -- flagged so it can be
  // tested and rolled back instantly without a deploy, and so it never
  // becomes the default until crash-safety is proven across multiple
  // sustained-load runs, not just one clean pass.
  useCopyIngest: boolean;
};

export type Config = {
  api: APIConfig;
  db: DBConfig;
};

export const config: Config = {
  api: {
    port: Number(process.env.PORT) || 8080,
    apiKey: process.env.API_KEY || "",
  },
  db: {
    url: process.env.DB_URL || "postgres://postgres:postgres@localhost:5432/logs_db",
    migrationConfig: {
      migrationsFolder: "./src/db/migrations",
    },
    retentionDays: Number(process.env.RETENTION_DAYS) || 30,
    useCopyIngest: process.env.USE_COPY_INGEST === "true",
  },
};