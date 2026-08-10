import { Request, Response } from 'express';
import { db } from '../db';
import { logs } from '../db/schema';
import { eq, and, gte, lt, ilike, desc, sql } from 'drizzle-orm';
import { validateGetLogsQuery } from '../validators/query';

export async function getLogsHandler(req: Request, res: Response) {
  try {
    const validatedData = validateGetLogsQuery(req, res);
    if (!validatedData) {
      return;
    }

    const { service, level, sinceDate, untilDate, q, limit, parsedCursor, attributes } = validatedData;

    const conditions = [];

    if (service) conditions.push(eq(logs.service, service));
    if (level) conditions.push(eq(logs.level, level));

    if (sinceDate) conditions.push(gte(logs.timestamp, sinceDate));
    if (untilDate) conditions.push(lt(logs.timestamp, untilDate));

    if (q) conditions.push(ilike(logs.message, `%${q}%`));

    Object.entries(attributes).forEach(([attrKey, attrValue]) => {
      conditions.push(sql`${logs.attributes}->>${attrKey} = ${attrValue}`);
    });

    if (parsedCursor) {
      const cDate = new Date(parsedCursor.timestamp);
      conditions.push(
        sql`(${logs.timestamp}, ${logs.id}) < (${cDate.toISOString()}::timestamp with time zone, ${Number(parsedCursor.id)})`
      );
    }

    const queryResults = await db
      .select()
      .from(logs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(logs.timestamp), desc(logs.id))
      .limit(limit + 1);

    const hasNext = queryResults.length > limit;
    const items = hasNext ? queryResults.slice(0, limit) : queryResults;

    let next_cursor: string | null = null;
    if (hasNext && items.length > 0) {
      const lastItem = items[items.length - 1];
      const payload = JSON.stringify({
        timestamp: lastItem.timestamp.toISOString(),
        id: lastItem.id,
      });
      next_cursor = Buffer.from(payload).toString('base64');
    }

    return res.status(200).json({
      logs: items,
      next_cursor,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}