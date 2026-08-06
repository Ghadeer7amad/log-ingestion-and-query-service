import type { MigrationConfig } from "drizzle-orm/migrator";

process.loadEnvFile();

export type APIConfig = {
  port: number;
  apiKey: string;
};

export type DBConfig = {
  url: string;
  migrationConfig: MigrationConfig;
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
  },
};