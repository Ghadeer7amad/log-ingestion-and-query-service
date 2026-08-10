import { Request, Response } from "express";
import { db } from "../db/index.js";
import { logs } from "../db/schema.js";
import { sql, SQL, and, eq, gte, lt, ilike } from "drizzle-orm";
import { validateAggregateQuery } from "../validators/aggregate.js";

function getBucketSql(bucket: string) {
  switch (bucket) {
    case "1m":
      return sql`date_trunc('minute', ${logs.timestamp})`;
    case "5m":
      return sql`to_timestamp(floor(extract(epoch from ${logs.timestamp}) / 300) * 300) AT TIME ZONE 'UTC'`;
    case "1h":
      return sql`date_trunc('hour', ${logs.timestamp})`;
    case "1d":
      return sql`date_trunc('day', ${logs.timestamp})`;
    default:
      return sql`date_trunc('minute', ${logs.timestamp})`;
  }
}

export async function aggregateLogsHandler(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const query = validateAggregateQuery(req, res);
    if (!query) {
      return; 
    }

    const { service, level, since, until, bucket, group_by, q, attributes } = query;

    const conditions: SQL[] = [
      gte(logs.timestamp, since),
      lt(logs.timestamp, until)
    ];

    if (service) conditions.push(eq(logs.service, service));
    if (level) conditions.push(eq(logs.level, level));
    if (q) conditions.push(ilike(logs.message, `%${q}%`));

    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        conditions.push(sql`${logs.attributes}->>${key} = ${value}`);
      }
    }

    const bucketSql = getBucketSql(bucket);

    const groupFieldSql = group_by === "service" 
      ? logs.service 
      : group_by === "level" 
      ? logs.level 
      : sql`NULL`;

    let queryBuilder = db
      .select({
        start: bucketSql,
        group: groupFieldSql,
        count: sql<number>`count(*)::int`,
      })
      .from(logs)
      .where(and(...conditions)) as any;

    if (group_by === "service") {
      queryBuilder = queryBuilder.groupBy(bucketSql, logs.service);
    } else if (group_by === "level") {
      queryBuilder = queryBuilder.groupBy(bucketSql, logs.level);
    } else {
      queryBuilder = queryBuilder.groupBy(bucketSql);
    }

    const results = await queryBuilder.orderBy(bucketSql);

    const formattedBuckets = results.map((row: any) => ({
      start: new Date(row.start).toISOString(),
      group: row.group ?? null,
      count: row.count,
    }));

    res.status(200).json({
      buckets: formattedBuckets,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
}