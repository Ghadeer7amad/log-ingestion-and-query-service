import { readClient } from '../index.js';

interface GetLogsQueryParams {
  service?: string;
  level?: string;
  sinceDate?: Date;
  untilDate?: Date;
  q?: string;
  attributes: Record<string, string>;
  parsedCursor?: { timestamp: string; id: number };
  limit: number;
}

export async function findLogs(params: GetLogsQueryParams) {
  const { service, level, sinceDate, untilDate, q, attributes, parsedCursor, limit } = params;

  const conditions = [];

  if (service) conditions.push(readClient`service = ${service}`);
  if (level) conditions.push(readClient`level = ${level}`);
  if (sinceDate) conditions.push(readClient`timestamp >= ${sinceDate.toISOString()}::timestamptz`);
  if (untilDate) conditions.push(readClient`timestamp < ${untilDate.toISOString()}::timestamptz`);
  if (q) conditions.push(readClient`message ILIKE ${'%' + q + '%'}`);
  if (Object.keys(attributes).length > 0) {
    // attr.<key> values always arrive as plain strings from the query
    // string, so match against attributes_search (every value stringified)
    // instead of the raw `attributes` column -- otherwise numeric/boolean
    // attribute values could never match (JSONB containment requires exact
    // type equality).
    conditions.push(readClient`attributes_search @> ${JSON.stringify(attributes)}::jsonb`);
  }
  if (parsedCursor) {
    const cursorDate = new Date(parsedCursor.timestamp).toISOString();
    conditions.push(readClient`(timestamp, id) < (${cursorDate}::timestamptz, ${parsedCursor.id})`);
  }

  const whereClause = conditions.length
    ? readClient`WHERE ${conditions.reduce((acc, cond, i) => (i === 0 ? cond : readClient`${acc} AND ${cond}`))}`
    : readClient``;

  // NULLS LAST here is required to match idx_logs_timestamp_id's definition
  // ("timestamp" DESC NULLS LAST, id DESC NULLS LAST -- Drizzle's index
  // builder always appends NULLS LAST for a .desc() column). Both columns
  // are NOT NULL, so this changes zero query results -- but without it, the
  // planner won't recognize the index as satisfying this ORDER BY at all,
  // and silently falls back to a full sequential scan + sort for every
  // unfiltered list and every cursor-paginated page (measured: 2.1s vs
  // 5.6ms unfiltered, 1.49s vs 1.4ms cursor-paginated, at 1M rows).
  const rows = await readClient`
    SELECT id, timestamp, level, service, message, attributes
    FROM logs
    ${whereClause}
    ORDER BY timestamp DESC NULLS LAST, id DESC NULLS LAST
    LIMIT ${limit + 1}
  `;

  return rows;
}