import { writeDb } from "../index.js";
import { sql } from "drizzle-orm";

const REFRESH_INTERVAL_MS = 5000;
// Re-upsert a trailing window on every tick rather than tracking a
// watermark: logs can arrive up to 5 minutes "in the future" and batches
// aren't guaranteed to land in timestamp order, so a bucket needs to stay
// revisable for a while after it's first written. Buckets older than this
// window are treated as finalized and never touched again -- cheap,
// self-healing, and the cost per tick is bounded by ingestion volume in the
// window, not by the size of the `logs` table.
const TRAILING_WINDOW_MINUTES = 15;

// Guards against overlapping runs: if a tick is still running when the next
// timer fires (e.g. Postgres is under heavy ingestion load), skip rather
// than stack up concurrent refreshes competing for the same CPU we're
// trying to relieve pressure on.
let isRefreshing = false;

export async function refreshRollup(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    await writeDb.execute(sql`
      INSERT INTO logs_rollup_minute (bucket_start, service, level, count)
      SELECT
        date_trunc('minute', timestamp) AS bucket_start,
        service,
        level,
        count(*) AS count
      FROM logs
      WHERE timestamp >= now() - make_interval(mins => ${TRAILING_WINDOW_MINUTES})
      GROUP BY date_trunc('minute', timestamp), service, level
      ON CONFLICT (bucket_start, service, level) DO UPDATE SET count = EXCLUDED.count
    `);
  } catch (error) {
    console.error("[Rollup] refresh failed:", error);
  } finally {
    isRefreshing = false;
  }
}

export function initRollupJob(): void {
  setInterval(refreshRollup, REFRESH_INTERVAL_MS);
}
