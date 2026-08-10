import { Request, Response } from 'express';
import { db } from '../db';
import { logs } from '../db/schema';
import { eq, and, gte, lt, ilike, desc, sql } from 'drizzle-orm';

export async function getLogsHandler(req: Request, res: Response) {
  try {
    const { service, level, since, until, q, limit: rawLimit, cursor } = req.query;

    const limit = rawLimit ? parseInt(rawLimit as string, 10) : 100;
    const conditions = [];

   
    if (service) conditions.push(eq(logs.service, service as string));
    if (level) conditions.push(eq(logs.level, level as string));

    
    if (since) conditions.push(gte(logs.timestamp, new Date(since as string)));
    if (until) conditions.push(lt(logs.timestamp, new Date(until as string)));

    
    if (q) conditions.push(ilike(logs.message, `%${q}%`));

    
    Object.keys(req.query).forEach((key) => {
      if (key.startsWith('attr.')) {
        const attrKey = key.replace('attr.', '');
        const attrValue = req.query[key] as string;
        conditions.push(sql`${logs.attributes}->>${attrKey} = ${attrValue}`);
      }
    });


    if (cursor) {
      const decoded = Buffer.from(cursor as string, 'base64').toString('utf-8');
      const { timestamp: cursorTime, id: cursorId } = JSON.parse(decoded);
      const cDate = new Date(cursorTime);

      conditions.push(
        sql`(${logs.timestamp}, ${logs.id}) < (${cDate.toISOString()}::timestamp with time zone, ${Number(cursorId)})`
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