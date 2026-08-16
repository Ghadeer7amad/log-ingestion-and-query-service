import { Request, Response, NextFunction } from "express";

export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}


export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}


export class TooManyRequestsError extends Error {
  // Seconds the client should wait before retrying. Fixed, not computed from
  // an actual queue-drain estimate -- current instrumentation (outstanding
  // row count) doesn't give a reliable ETA, so a conservative constant is
  // used instead of a precise-looking number that isn't actually precise.
  retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number = 2) {
    super(message);
    this.name = "TooManyRequestsError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// The 4-argument signature is required for Express to recognize this as
// error-handling middleware -- it dispatches purely on function arity, not
// parameter names, so `_next` stays in the signature even though every
// branch below returns a response directly and never calls it.
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof BadRequestError) {
    return res.status(400).json({ error: err.message });
  }

  if (err instanceof UnauthorizedError) {
    return res.status(401).json({ error: err.message });
  }

  if (err instanceof ForbiddenError) {
    return res.status(403).json({ error: err.message });
  }

  if (err instanceof NotFoundError) {
    return res.status(404).json({ error: err.message });
  }

  if (err instanceof TooManyRequestsError) {
    res.set("Retry-After", String(err.retryAfterSeconds));
    return res.status(429).json({ error: err.message });
  }

  if (err instanceof SyntaxError && "status" in err && err.status === 400) {
    return res.status(400).json({ error: "Malformed JSON payload" });
  }

  if ("type" in err && (err as any).type === "entity.too.large") {
    return res.status(413).json({ error: "Request body exceeds the maximum allowed size" });
  }

  console.error("[Unhandled Error]:", err);
  return res.status(500).json({ error: "Internal Server Error" });
}

