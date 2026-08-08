import { Request, Response } from 'express';
import { queryClient } from '../db/index.js';

let isAppReady = false;

export const setAppReady = (ready: boolean): void => {
  isAppReady = ready;
};

export const healthHandler = async (req: Request, res: Response): Promise<void> => {

  if (!isAppReady) {
    res.status(503).json({ 
      status: 'unhealthy', 
      error: 'Migrations or app initialization pending' 
    });
    return;
  }
  
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