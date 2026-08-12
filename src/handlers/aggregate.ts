import { Request, Response } from "express";
import { validateAggregateQuery } from "../validators/aggregate.js";
import { fetchAggregateLogsFromDb } from "../db/queries/aggregate_logs.js";

export async function aggregateLogsHandler(req: Request, res: Response): Promise<void> {
  try {
    const query = validateAggregateQuery(req, res);
    if (!query) {
      return;
    }

    const results = await fetchAggregateLogsFromDb(query);

    const formattedBuckets = results.map((row: any) => ({
      start: new Date(row.start).toISOString(),
      group: row.group ?? null,
      count: row.count,
    }));

    res.status(200).json({
      buckets: formattedBuckets,
    });
  } catch (error) {
    console.error("Error in aggregateLogsHandler:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}