import { readDb } from "../index.js";
import { logs } from "../schema.js";
import { sql, SQL, and, eq, gte, lt, ilike, type SQLWrapper } from "drizzle-orm";
import { queryAggregateCache } from "../aggregateCache.js";

interface AggregateParams {
  service?: string;
  level?: string;
  since: Date;
  until: Date;
  bucket: "1m" | "5m" | "1h" | "1d";
  group_by?: "service" | "level";
  q?: string;
  attributes?: Record<string, string>;
}

function getBucketSql(bucket: string, column: SQLWrapper) {
  switch (bucket) {
    case "1m":
      return sql`date_trunc('minute', ${column})`;
    case "5m":
      return sql`to_timestamp(floor(extract(epoch from ${column}) / 300) * 300) AT TIME ZONE 'UTC'`;
    case "1h":
      return sql`date_trunc('hour', ${column})`;
    case "1d":
      return sql`date_trunc('day', ${column})`;
    default:
      return sql`date_trunc('minute', ${column})`;
  }
}

async function fetchAggregateFromRawLogs(params: AggregateParams) {
  const { service, level, since, until, bucket, group_by, q, attributes } = params;

  const conditions: SQL[] = [
    gte(logs.timestamp, since),
    lt(logs.timestamp, until)
  ];

  if (service) conditions.push(eq(logs.service, service));
  if (level) conditions.push(eq(logs.level, level));
  if (q) conditions.push(ilike(logs.message, `%${q}%`));

  if (attributes) {
    for (const [key, value] of Object.entries(attributes)) {
      conditions.push(sql`${logs.attributesSearch} @> ${JSON.stringify({ [key]: value })}::jsonb`);
    }
  }

  const bucketSql = getBucketSql(bucket, logs.timestamp);

  const groupFieldSql = group_by === "service"
    ? logs.service
    : group_by === "level"
    ? logs.level
    : sql`NULL`;

  let queryBuilder = readDb
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

  return queryBuilder.orderBy(bucketSql);
}

export async function fetchAggregateLogsFromDb(params: AggregateParams) {
  const hasRawOnlyFilter = !!params.q || (!!params.attributes && Object.keys(params.attributes).length > 0);

  if (!hasRawOnlyFilter) {
    return queryAggregateCache({
      since: params.since,
      until: params.until,
      bucket: params.bucket,
      group_by: params.group_by,
      service: params.service,
      level: params.level,
    });
  }

  return fetchAggregateFromRawLogs(params);
}
