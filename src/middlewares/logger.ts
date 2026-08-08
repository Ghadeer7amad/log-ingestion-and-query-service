import { Request, Response, NextFunction } from "express";

export function logNonOkResponses(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    if (res.statusCode >= 400) {
      console.log(`[NON-OK] ${req.method} ${req.url} - Status: ${res.statusCode}`);
    }
  });
  next();
}