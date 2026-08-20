import express from "express";
import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { healthHandler, setAppReady } from "./handlers/health.js";
import { ingestLogsHandler } from "./handlers/ingest.js";
import { getLogsHandler } from "./handlers/query.js";
import { aggregateLogsHandler } from "./handlers/aggregate.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { logNonOkResponses } from "./middlewares/logger.js";
import { initRetentionJob } from "./db/queries/retention.js";
import { primeAggregateCacheFromDb } from "./db/aggregateCache.js";


const app = express();
const PORT = config.api?.port || 8080;

app.use(logNonOkResponses);

app.get("/health", healthHandler);
app.post("/logs", express.json({ limit: "1mb" }), ingestLogsHandler);
app.get('/logs', getLogsHandler);
app.get('/logs/aggregate', aggregateLogsHandler);


app.use(errorHandler);

async function startServer(): Promise<void> {
  try {
    console.log("Running database migrations...");
    await runMigrations();
    console.log("Database migrations applied successfully.");

    await primeAggregateCacheFromDb(config.db.retentionDays);
    setAppReady(true);

    initRetentionJob();

    const server = app.listen({ port: PORT, backlog: 128 }, () => {
      console.log(`Log Engine server is running on port ${PORT}`);
    });

    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();