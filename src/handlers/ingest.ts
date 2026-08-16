import { Request, Response, NextFunction } from 'express';
import { validateLogBatch } from '../validators/ingest.js';
import { enqueueLogsForInsert } from '../db/queries/ingestQueue.js';
import { BadRequestError } from '../middlewares/errorHandler.js';

export const ingestLogsHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.body || typeof req.body !== 'object' || !Array.isArray(req.body.logs)) {
      throw new BadRequestError("Invalid request structure: must contain 'logs' array");
    }

    const rawLogs = req.body.logs;
    if (rawLogs.length === 0) {
      throw new BadRequestError("logs array must contain at least one log entry");
    }

    const { batch, rejected } = validateLogBatch(rawLogs);

    if (batch.count === 0) {
      res.status(400).json({
        accepted: 0,
        rejected
      });
      return;
    }

    const acceptedCount = await enqueueLogsForInsert(batch);

    res.status(200).json({
      accepted: acceptedCount,
      rejected
    });

  } catch (error) {
    next(error);
  }
};
