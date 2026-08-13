import { Request, Response } from 'express';
import { validateGetLogsQuery } from '../validators/query.js';
import { findLogs } from '../db/queries/get_logs.js';

export async function getLogsHandler(req: Request, res: Response) {
  try {
    const validatedData = validateGetLogsQuery(req, res);
    if (!validatedData) return;

    const { service, level, sinceDate, untilDate, q, limit, parsedCursor, attributes } = validatedData;

    const queryResults = await findLogs({
      service,
      level,
      sinceDate,
      untilDate,
      q,
      attributes,
      parsedCursor,
      limit,
    });

    const hasNext = queryResults.length > limit;
    const items = hasNext ? queryResults.slice(0, limit) : queryResults;

    let next_cursor: string | null = null;
    if (hasNext && items.length > 0) {
      const lastItem = items[items.length - 1];
      const payload = JSON.stringify({
        timestamp: new Date(lastItem.timestamp).toISOString(),
        id: Number(lastItem.id),
      });
      next_cursor = Buffer.from(payload).toString('base64');
    }

    const logs = items.map((item) => ({
      id: String(item.id),
      timestamp: new Date(item.timestamp).toISOString(),
      level: item.level,
      service: item.service,
      message: item.message,
      attributes: item.attributes,
    }));

    return res.status(200).json({
      logs,
      next_cursor,
    });
  } catch (error) {
    console.error('Error in getLogsHandler:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}