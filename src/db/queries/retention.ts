import { db } from "../index.js"; 
import { sql } from "drizzle-orm";
import { config } from "../../config.js"; 


export async function cleanExpiredLogs() {
  try {
    const retentionDays = config.db.retentionDays;
    console.log(`[Retention Strategy] Cleaning logs older than ${retentionDays} days...`);
    
    
    await db.execute(
      sql`DELETE FROM logs WHERE timestamp < NOW() - make_interval(days => ${retentionDays})`
    );
    
    console.log("[Retention Strategy] Cleanup completed successfully.");
  } catch (error) {
    console.error("[Retention Strategy] Error during logs cleanup:", error);
  }
}


export function initRetentionJob() {
  const CHECK_INTERVAL = 24 * 60 * 60 * 1000; 
  
  
  setTimeout(cleanExpiredLogs, 5000);
  
 
  setInterval(cleanExpiredLogs, CHECK_INTERVAL);
}