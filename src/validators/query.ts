import { Request, Response, NextFunction } from 'express';

const VALID_LEVELS = new Set(['info', 'warn', 'error', 'debug']);

export function validateGetLogsQuery(req: Request, res: Response, next: NextFunction) {
  const { level, limit, since, until, cursor } = req.query;

  
  if (level && !VALID_LEVELS.has(level as string)) {
    return res.status(400).json({ error: 'Unsupported log level' });
  }

  
  if (limit !== undefined) {
    const parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || isNaN(parsedLimit)) {
      return res.status(400).json({ error: 'Limit must be a valid integer' });
    }
    if (parsedLimit < 1 || parsedLimit > 1000) {
      return res.status(400).json({ error: 'Limit must be between 1 and 1000' });
    }
  }

 
  let sinceDate: Date | null = null;
  let untilDate: Date | null = null;

  if (since) {
    sinceDate = new Date(since as string);
    if (isNaN(sinceDate.getTime())) {
      return res.status(400).json({ error: 'Invalid timestamp for "since"' });
    }
  }

  if (until) {
    untilDate = new Date(until as string);
    if (isNaN(untilDate.getTime())) {
      return res.status(400).json({ error: 'Invalid timestamp for "until"' });
    }
  }

  
  if (sinceDate && untilDate && untilDate < sinceDate) {
    return res.status(400).json({ error: '"until" cannot be earlier than "since"' });
  }

  
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor as string, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      if (!parsed.timestamp || !parsed.id) {
        return res.status(400).json({ error: 'Malformed cursor structure' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid or malformed cursor' });
    }
  }

  next();
}