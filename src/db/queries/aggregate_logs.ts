import { readDb } from "../index.js";
import { logs, logsRollupMinute } from "../schema.js";
import { sql, SQL, and, eq, gte, lt, ilike, type SQLWrapper } from "drizzle-orm";

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

// Fast path: reads from the pre-aggregated rollup table (see queries/rollup.ts)
// instead of scanning `logs`. Only valid when there's no `q` or `attr.<key>`
// filter, since the rollup's grouping key is (minute, service, level) and
// doesn't carry message text or attributes. 5m/1h/1d buckets are computed by
// re-bucketing the rollup's 1m rows -- date_trunc/floor-to-N-seconds compose
// cleanly over an already-minute-truncated timestamp, so results are
// identical to computing the same bucket directly off raw timestamps.
async function fetchAggregateFromRollup(params: AggregateParams) {
  const { service, level, since, until, bucket, group_by } = params;

  const conditions: SQL[] = [
    gte(logsRollupMinute.bucketStart, since),
    lt(logsRollupMinute.bucketStart, until),
  ];
  if (service) conditions.push(eq(logsRollupMinute.service, service));
  if (level) conditions.push(eq(logsRollupMinute.level, level));

  const bucketSql = getBucketSql(bucket, logsRollupMinute.bucketStart);

  const groupFieldSql = group_by === "service"
    ? logsRollupMinute.service
    : group_by === "level"
    ? logsRollupMinute.level
    : sql`NULL`;

  let queryBuilder = readDb
    .select({
      start: bucketSql,
      group: groupFieldSql,
      count: sql<number>`SUM(${logsRollupMinute.count})::int`,
    })
    .from(logsRollupMinute)
    .where(and(...conditions)) as any;

  if (group_by === "service") {
    queryBuilder = queryBuilder.groupBy(bucketSql, logsRollupMinute.service);
  } else if (group_by === "level") {
    queryBuilder = queryBuilder.groupBy(bucketSql, logsRollupMinute.level);
  } else {
    queryBuilder = queryBuilder.groupBy(bucketSql);
  }

  return queryBuilder.orderBy(bucketSql);
}

// Slow path: scans `logs` directly. Required whenever `q` (message
// substring) or `attr.<key>` filters are present, since neither is part of
// the rollup's grouping key.
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
    // attr.<key> values always arrive as plain strings from the query
    // string, so match against attributesSearch (every value stringified)
    // instead of the raw `attributes` column -- otherwise numeric/boolean
    // attribute values could never match (JSONB containment requires exact
    // type equality).
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
  return hasRawOnlyFilter ? fetchAggregateFromRawLogs(params) : fetchAggregateFromRollup(params);
}
