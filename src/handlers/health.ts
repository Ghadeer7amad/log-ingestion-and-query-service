import { Request, Response } from 'express';
import { queryClient } from '../db/index.js';

export const healthHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    await queryClient`SELECT 1`;
    res.status(200).json({ status: 'ok' });
  } catch (error) {
    console.error('Health check DB failed:', error);
    res.status(503).json({ 
      status: 'unhealthy', 
      error: 'Database connection or migrations not ready' 
    });
  }
};