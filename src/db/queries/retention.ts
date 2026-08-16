import { writeDb } from "../index.js";
import { sql } from "drizzle-orm";
import { config } from "../../config.js";
import { pruneBucketsOlderThan } from "../aggregateCache.js";

const BATCH_SIZE = 5000;
const DELAY_BETWEEN_BATCHES_MS = 200;

export async function cleanExpiredLogs() {
  try {
    const retentionDays = config.db.retentionDays;
    console.log(`[Retention Strategy] Cleaning logs older than ${retentionDays} days...`);

    let totalDeleted = 0;

    while (true) {
      const result = await writeDb.execute(
        sql`
          DELETE FROM logs
          WHERE id IN (
            SELECT id FROM logs
            WHERE timestamp < NOW() - make_interval(days => ${retentionDays})
            LIMIT ${BATCH_SIZE}
          )
        `
      );

      const deletedCount = result.count ?? 0;
      totalDeleted += deletedCount;

      if (deletedCount < BATCH_SIZE) break;

      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
    }

    pruneBucketsOlderThan(new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000));

    console.log(`[Retention Strategy] Cleanup completed. Total deleted: ${totalDeleted}`);
  } catch (error) {
    console.error("[Retention Strategy] Error during logs cleanup:", error);
  }
}

export function initRetentionJob() {
  const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

  setTimeout(cleanExpiredLogs, 60_000);

  setInterval(cleanExpiredLogs, CHECK_INTERVAL);
}