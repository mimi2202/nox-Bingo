import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHash, timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { getConfig, buildNextConfig, saveConfig } from './gameConfig';
import { getRoomStats } from './RoomManager';
import { soloReturnProblems } from './winOdds';

const ADMIN_TOKEN_TTL = '4h';

// Brute-force protection for /admin/login. The budget is GLOBAL, not
// per IP: IP headers behind a proxy can be forged, so a per-IP limit is
// easy to dodge. The trade-off is that someone hammering the endpoint
// can lock the real admin out for up to LOCKOUT_WINDOW_MS — annoying,
// but it is temporary and no one gets in.
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;
const failedLogins: number[] = [];

// Solo payouts must not, on average, hand back more than this share of
// what players stake. Set MAX_SOLO_RETURN (e.g. 0.9) to change it.
const MAX_SOLO_RETURN = Number(process.env.MAX_SOLO_RETURN) || 0.95;

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

// Tell the operator about weak secrets once at startup.
try {
  if (getAdminPassword().length < 14) console.warn('[admin] ADMIN_PASSWORD is short — use 14+ random characters.');
  if (getJwtSecret().length < 32) console.warn('[admin] ADMIN_JWT_SECRET is short — use 32+ random characters.');
} catch (err) {
  console.warn('[admin] ' + (err instanceof Error ? err.message : err));
}

// Compares in constant time so response timing can't leak how many
// leading characters of the password were right.
function passwordMatches(candidate: string, actual: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(actual).digest();
  return timingSafeEqual(a, b);
}

function recentFailures(): number {
  const cutoff = Date.now() - LOCKOUT_WINDOW_MS;
  while (failedLogins.length > 0 && failedLogins[0] < cutoff) failedLogins.shift();
  return failedLogins.length;
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing admin token' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), getJwtSecret(), { algorithms: ['HS256'] });
    if (typeof payload !== 'object' || payload.role !== 'admin') throw new Error('wrong role');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

export const adminRouter = Router();

adminRouter.post('/login', async (req: Request, res: Response) => {
  if (recentFailures() >= MAX_FAILED_LOGINS) {
    res.setHeader('Retry-After', String(Math.ceil(LOCKOUT_WINDOW_MS / 1000)));
    res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    return;
  }

  const { password } = req.body || {};
  let ok = false;
  try {
    ok = typeof password === 'string' && password.length <= 256 && passwordMatches(password, getAdminPassword());
  } catch {
    res.status(500).json({ error: 'Admin login is not configured.' });
    return;
  }

  if (!ok) {
    failedLogins.push(Date.now());
    console.warn('[admin] failed login (' + recentFailures() + '/' + MAX_FAILED_LOGINS + ' in window)');
    // Small fixed delay slows each guess without hurting the real admin.
    await new Promise(resolve => setTimeout(resolve, 500));
    // Same message either way — don't give an attacker feedback.
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const token = jwt.sign({ role: 'admin' }, getJwtSecret(), { expiresIn: ADMIN_TOKEN_TTL, algorithm: 'HS256' });
  res.json({ token });
});

adminRouter.get('/config', requireAdminAuth, (_req: Request, res: Response) => {
  res.json(getConfig());
});

adminRouter.put('/config', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;

    // Validate first, THEN check profitability on the validated config
    // (what would really go live), including new bundles' default
    // multipliers and the jackpot.
    const next = buildNextConfig(body);
    const problems = soloReturnProblems(next, MAX_SOLO_RETURN);
    if (problems.length > 0) {
      res.status(400).json({
        error: 'This change would make solo play unprofitable for the house. ' + problems.join(' '),
      });
      return;
    }

    const updated = await saveConfig(next);
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