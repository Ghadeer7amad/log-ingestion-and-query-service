import express from "express";
import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { healthHandler, setAppReady } from "./handlers/health.js";
import { errorHandler } from "./middlewares/errorHandler.js";
import { logNonOkResponses } from "./middlewares/logger.js";

const app = express();
const PORT = config.api?.port || 8080;

app.use(express.json({ limit: "10mb" }));
app.use(logNonOkResponses);

app.get("/health", healthHandler);

app.use(errorHandler);

async function startServer(): Promise<void> {
  try {
    console.log("Running database migrations...");
    await runMigrations();
    setAppReady(true);
    console.log("Database migrations applied successfully.");

    app.listen(PORT, () => {
      console.log(`Log Engine server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();