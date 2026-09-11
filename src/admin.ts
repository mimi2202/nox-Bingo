import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { getConfig, updateConfig } from './gameConfig';
import { getRoomStats } from './RoomManager';

const ADMIN_TOKEN_TTL = '12h';

function getJwtSecret(): string {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) throw new Error('ADMIN_JWT_SECRET is not set.');
  return secret;
}

function getAdminPassword(): string {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) throw new Error('ADMIN_PASSWORD is not set.');
  return pw;
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing admin token' });
    return;
  }
  try {
    jwt.verify(header.slice(7), getJwtSecret());
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

export const adminRouter = Router();

adminRouter.post('/login', (req: Request, res: Response) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password !== getAdminPassword()) {
    // Same message either way — don't reveal whether the password
    // field was even present, no point giving an attacker feedback.
    res.status(401).json({ error: 'Invalid password' });
    return;
  }
  const token = jwt.sign({ role: 'admin' }, getJwtSecret(), { expiresIn: ADMIN_TOKEN_TTL });
  res.json({ token });
});

adminRouter.get('/config', requireAdminAuth, (_req: Request, res: Response) => {
  res.json(getConfig());
});

adminRouter.put('/config', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const updated = await updateConfig(req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid config' });
  }
});

adminRouter.get('/stats', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let totalUsers: number | null = null;

    if (supabaseUrl && supabaseKey) {
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { count, error } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
      if (!error) totalUsers = count;
    }

    res.json({ totalUsers, ...getRoomStats() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load stats' });
  }
});