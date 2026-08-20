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
    conditions.push(readClient`attributes_search @> ${JSON.stringify(attributes)}::jsonb`);
  }
  if (parsedCursor) {
    const cursorDate = new Date(parsedCursor.timestamp).toISOString();
    conditions.push(readClient`(timestamp, id) < (${cursorDate}::timestamptz, ${parsedCursor.id})`);
  }

  const whereClause = conditions.length
    ? readClient`WHERE ${conditions.reduce((acc, cond, i) => (i === 0 ? cond : readClient`${acc} AND ${cond}`))}`
    : readClient``;

  const rows = await readClient`
    SELECT id, timestamp, level, service, message, attributes
    FROM logs
    ${whereClause}
    ORDER BY timestamp DESC NULLS LAST, id DESC NULLS LAST
    LIMIT ${limit + 1}
  `;

  return rows;
}