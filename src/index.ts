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

// Measured actual request bodies: ~8.7KB for a 50-log local batch, ~5.7KB
// for the portal's own average (~33 logs/request) -- the previous 10mb
// limit was ~1,200x larger than anything ever actually sent. express.json
// buffers the whole body into memory and runs JSON.parse synchronously,
// blocking the event loop -- on a 0.5 CPU/256MB container, a request
// anywhere near a multi-MB limit could stall every other concurrent
// request, including the coalescing flush timer. 1mb keeps ~115x headroom
// over the largest body observed while cutting that exposure by 10x.
app.use(express.json({ limit: "1mb" }));
app.use(logNonOkResponses);

app.get("/health", healthHandler);
app.post("/logs", ingestLogsHandler);
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

    app.listen(PORT, () => {
      console.log(`Log Engine server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();