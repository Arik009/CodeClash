import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { type Db } from 'mongodb';
import { HttpError } from '../domain/errors.js';

export interface AppDeps {
  db: Db;
  redis: {
    get: (key: string) => Promise<string | null>;
    ping?: () => Promise<string>;
  };
  log?: { info: (obj: unknown, msg?: string) => void };
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createApp(deps: AppDeps) {
  const { db, redis } = deps;
  const app = express();
  app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173' }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', asyncRoute(async (_req, res) => {
    await db.command({ ping: 1 });
    if (redis.ping) await redis.ping();
    else await redis.get('health:ping');
    res.json({ ok: true, mongo: true, redis: true });
  }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    deps.log?.info({ err: error }, 'unhandled');
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
