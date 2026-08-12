import { Request, Response } from "express";

export interface AggregateQueryParams {
  service?: string;
  level?: string;
  since: Date;
  until: Date;
  bucket: "1m" | "5m" | "1h" | "1d";
  group_by?: "service" | "level";
  q?: string;
  attributes?: Record<string, string>;
}

export function validateAggregateQuery(
  req: Request,
  res: Response
): AggregateQueryParams | null {
  const { service, level, since, until, bucket, group_by, q } = req.query;

  if (!since || !until || !bucket) {
    res.status(400).json({ error: "Missing required parameters: since, until, and bucket are required" });
    return null;
  }

  if (level) {
    const validLevels = ["debug", "info", "warn", "error"];
    if (typeof level !== "string" || !validLevels.includes(level.toLowerCase())) {
      res.status(400).json({ error: "Unsupported log level" });
      return null;
    }
  }

  const sinceDate = new Date(since as string);
  const untilDate = new Date(until as string);

  if (isNaN(sinceDate.getTime()) || isNaN(untilDate.getTime())) {
    res.status(400).json({ error: "Invalid date format for since or until" });
    return null;
  }

  if (untilDate < sinceDate) {
    res.status(400).json({ error: "'until' must not be earlier than 'since'" });
    return null;
  }

  const validBuckets = ["1m", "5m", "1h", "1d"];
  if (typeof bucket !== "string" || !validBuckets.includes(bucket as string)) {
    res.status(400).json({ error: "Invalid bucket value. Allowed: 1m, 5m, 1h, 1d" });
    return null;
  }

  if (group_by) {
    const validGroupBy = ["service", "level"];
    if (typeof group_by !== "string" || !validGroupBy.includes((group_by as string).toLowerCase())) {
      res.status(400).json({ error: "Invalid group_by. Allowed: service, level" });
      return null;
    }
  }

  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (key.startsWith("attr.") && typeof value === "string") {
      const attrKey = key.slice(5);
      if (attrKey.length > 0) {
        attributes[attrKey] = value;
      }
    }
  }

  return {
    service: typeof service === "string" ? service : undefined,
    level: typeof level === "string" ? level.toLowerCase() : undefined,
    since: sinceDate,
    until: untilDate,
    bucket: bucket as "1m" | "5m" | "1h" | "1d",
    group_by: typeof group_by === "string" ? (group_by.toLowerCase() as "service" | "level") : undefined,
    q: typeof q === "string" ? q : undefined,
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
  };
}