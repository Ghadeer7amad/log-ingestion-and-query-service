import { Request, Response } from 'express';

const VALID_LEVELS = new Set(['info', 'warn', 'error', 'debug']);

export interface ValidatedGetLogsQuery {
  service?: string;
  level?: string;
  sinceDate?: Date;
  untilDate?: Date;
  q?: string;
  limit: number;
  parsedCursor?: { timestamp: string; id: number };
  attributes: Record<string, string>;
}

export function validateGetLogsQuery(req: Request, res: Response): ValidatedGetLogsQuery | null {
  const { service, level, limit: rawLimit, since, until, q, cursor } = req.query;

  
  if (level && !VALID_LEVELS.has(level as string)) {
    res.status(400).json({ error: 'Unsupported log level' });
    return null;
  }

  
  let limit = 100;
  if (rawLimit !== undefined) {
    const parsedLimit = Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || isNaN(parsedLimit)) {
      res.status(400).json({ error: 'Limit must be a valid integer' });
      return null;
    }
    if (parsedLimit < 1 || parsedLimit > 1000) {
      res.status(400).json({ error: 'Limit must be between 1 and 1000' });
      return null;
    }
    limit = parsedLimit;
  }

  
  let sinceDate: Date | undefined;
  let untilDate: Date | undefined;

  if (since) {
    sinceDate = new Date(since as string);
    if (isNaN(sinceDate.getTime())) {
      res.status(400).json({ error: 'Invalid timestamp for "since"' });
      return null;
    }
  }

  if (until) {
    untilDate = new Date(until as string);
    if (isNaN(untilDate.getTime())) {
      res.status(400).json({ error: 'Invalid timestamp for "until"' });
      return null;
    }
  }

  if (sinceDate && untilDate && untilDate < sinceDate) {
    res.status(400).json({ error: '"until" cannot be earlier than "since"' });
    return null;
  }

  
  let parsedCursor: { timestamp: string; id: number } | undefined;
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor as string, 'base64').toString('utf-8');
      parsedCursor = JSON.parse(decoded);
      if (!parsedCursor?.timestamp || parsedCursor?.id === undefined) {
        res.status(400).json({ error: 'Malformed cursor structure' });
        return null;
      }
    } catch {
      res.status(400).json({ error: 'Invalid or malformed cursor' });
      return null;
    }
  }

  
  const attributes: Record<string, string> = {};
  Object.keys(req.query).forEach((key) => {
    if (key.startsWith('attr.')) {
      const attrKey = key.replace('attr.', '');
      attributes[attrKey] = req.query[key] as string;
    }
  });

  return {
    service: service as string | undefined,
    level: level as string | undefined,
    sinceDate,
    untilDate,
    q: q as string | undefined,
    limit,
    parsedCursor,
    attributes,
  };
}