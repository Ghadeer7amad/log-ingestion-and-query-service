import { queryClient } from '../index.js';

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

  if (service) conditions.push(queryClient`service = ${service}`);
  if (level) conditions.push(queryClient`level = ${level}`);
  if (sinceDate) conditions.push(queryClient`timestamp >= ${sinceDate.toISOString()}::timestamptz`);
  if (untilDate) conditions.push(queryClient`timestamp < ${untilDate.toISOString()}::timestamptz`);
  if (q) conditions.push(queryClient`message ILIKE ${'%' + q + '%'}`);
  if (Object.keys(attributes).length > 0) {
    conditions.push(queryClient`attributes_search @> ${JSON.stringify(attributes)}::jsonb`);
  }
  if (parsedCursor) {
    const cursorDate = new Date(parsedCursor.timestamp).toISOString();
    conditions.push(queryClient`(timestamp, id) < (${cursorDate}::timestamptz, ${parsedCursor.id})`);
  }

  const whereClause = conditions.length
    ? queryClient`WHERE ${conditions.reduce((acc, cond, i) => (i === 0 ? cond : queryClient`${acc} AND ${cond}`))}`
    : queryClient``;

  const rows = await queryClient`
    SELECT id, timestamp, level, service, message, attributes
    FROM logs
    ${whereClause}
    ORDER BY timestamp DESC, id DESC
    LIMIT ${limit + 1}
  `;

  return rows;
}