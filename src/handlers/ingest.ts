import { Request, Response, NextFunction } from 'express';
import { validateAndTransformLog, ValidatedLog } from '../validators/logValidator.js';
import { insertValidLogsBulk } from '../db/queries/logs.js';
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

    const validLogs: ValidatedLog[] = [];
    const rejected: Array<{ index: number; reason: string }> = [];

    for (let i = 0; i < rawLogs.length; i++) {
      const { error, data } = validateAndTransformLog(rawLogs[i]);
      if (error) {
        rejected.push({ index: i, reason: error });
      } else if (data) {
        validLogs.push(data);
      }
    }

    if (validLogs.length === 0) {
      res.status(400).json({
        accepted: 0,
        rejected
      });
      return;
    }


    const acceptedCount = await insertValidLogsBulk(validLogs);

    res.status(200).json({
      accepted: acceptedCount,
      rejected
    });

  } catch (error) {
    next(error);
  }
};