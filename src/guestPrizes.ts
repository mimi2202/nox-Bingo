import { createHash, randomBytes } from 'crypto';
import { Request, Response, Router } from 'express';
import { challengeMessage, cleanWallet, verifyWalletSignature } from './walletProof';
import { verifyFarcasterBase64Quirk } from './farcasterProof';
import { GUEST_PRIZE_STATUSES, GuestPrizeRow, GuestPrizeStatus, GuestPrizeStore } from './guestPrizeStore';

/**
 * Guest prizes: a guest who wins a free game gets a real OREN prize, held
 * until they claim it with an account and a wallet.
 *
 * The claim token is a secret: it goes only to the winning socket and must
 * never be logged. Only its sha256 is stored.
 */

export interface GuestPrizeSettings {
  enabled: boolean;
  ttlHours: number;
  dailyBudgetOren: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadGuestPrizeSettings(env: NodeJS.ProcessEnv = process.env): GuestPrizeSettings {
  return {
    enabled: env.GUEST_PRIZE_ENABLED === 'true',
    ttlHours: positiveNumber(env.GUEST_PRIZE_TTL_HOURS, 48),
    dailyBudgetOren: positiveNumber(env.GUEST_PRIZE_DAILY_BUDGET_OREN, 500),
  };
}

export type PayoutResult =
  | { ok: true; txSignature: string }
  // unconfirmed = the transfer may have landed even though it wasn't confirmed.
  | { ok: false; unconfirmed: boolean; error: string };

export interface GuestPrizeDeps {
  settings: GuestPrizeSettings;
  store: GuestPrizeStore;
  /** The live 1-card solo win amount, or null if the config has no such bundle. */
  prizeAmount: () => number | null;
  /** Checks a Supabase access token. */
  userIdFromToken: (accessToken: string) => Promise<string | null>;
  payout: (walletAddress: string, amountOren: number, roomCode: string) => Promise<PayoutResult>;
}

export function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Creating a prize when a guest wins ──────────────────────────────

export interface GuestWin {
  roomCode: string;
  ip: string;
  // The game carries on while a player is disconnected, so a winner may be
  // away (say, switched apps) and come back. What matters is whether the room
  // still exists for them to come back to.
  isRoomOpen: () => boolean;
  deliver: (message: object, prizeId: string | null) => void;
}

/**
 * The prize message for each finished guest room, kept until the room closes.
 * A winner who is away gets it when they reconnect, and so does one who
 * reconnects later, since the website rebuilds its state from a replay.
 * If the room closes and it never reached them, nobody can ever hold that
 * token, so the prize is withdrawn: it must not keep their one pending slot
 * and today's budget for no one.
 */
export class HeldGuestPrizes {
  private held = new Map<string, { message: object; prizeId: string | null; delivered: boolean }>();

  constructor(private store: Pick<GuestPrizeStore, 'cancel'>) {}

  deliver(roomCode: string, message: object, prizeId: string | null, sendNow: (message: object) => boolean): void {
    this.held.set(roomCode, { message, prizeId, delivered: sendNow(message) });
  }

  resend(roomCode: string, send: (message: object) => void): void {
    const entry = this.held.get(roomCode);
    if (!entry) return;
    send(entry.message);
    entry.delivered = true;
  }

  async roomClosed(roomCode: string): Promise<void> {
    const entry = this.held.get(roomCode);
    if (!entry) return;
    this.held.delete(roomCode);
    if (entry.delivered || !entry.prizeId) return;
    try {
      await this.store.cancel(entry.prizeId);
    } catch (err) {
      // It will still expire on its own.
      console.error('[guest-prize] could not withdraw undelivered prize ' + entry.prizeId + ':', err);
    }
  }
}

export async function awardGuestPrize(deps: GuestPrizeDeps, win: GuestWin): Promise<void> {
  // When switched off the website must behave exactly as it does today.
  if (!deps.settings.enabled) return;
  try {
    const amountOren = deps.prizeAmount();
    if (amountOren === null || !(amountOren > 0)) {
      console.error('[guest-prize] no usable 1-card prize amount in the live config');
      win.deliver({ type: 'guest_prize_unavailable', reason: 'limit_reached' }, null);
      return;
    }
    const claimToken = randomBytes(32).toString('base64url');
    const created = await deps.store.create({
      tokenHash: hashClaimToken(claimToken),
      amountOren,
      roomCode: win.roomCode,
      guestIp: win.ip,
      ttlHours: deps.settings.ttlHours,
      dailyBudgetOren: deps.settings.dailyBudgetOren,
    });
    if (created.result !== 'created') {
      win.deliver({ type: 'guest_prize_unavailable', reason: created.result }, null);
      return;
    }
    // The room closed while the prize was being saved: no one can receive it.
    if (!win.isRoomOpen()) {
      await deps.store.cancel(created.id);
      return;
    }
    win.deliver(
      {
        type: 'guest_prize',
        claimToken,
        amountOren,
        expiresAt: new Date(created.expires_at).toISOString(),
      },
      created.id
    );
  } catch (err) {
    console.error('[guest-prize] could not create prize, room ' + win.roomCode + ':', err);
    win.deliver({ type: 'guest_prize_unavailable', reason: 'limit_reached' }, null);
  }
}

// ── Abuse limit: guest games per IP ─────────────────────────────────

const GUEST_GAMES_PER_WINDOW = 20;
const GUEST_GAME_WINDOW_MS = 60 * 60 * 1000;
const guestGames = new Map<string, number[]>();

export function allowGuestGame(ip: string, now: number = Date.now()): boolean {
  const recent = (guestGames.get(ip) ?? []).filter(t => now - t < GUEST_GAME_WINDOW_MS);
  if (recent.length >= GUEST_GAMES_PER_WINDOW) {
    guestGames.set(ip, recent);
    return false;
  }
  recent.push(now);
  guestGames.set(ip, recent);
  return true;
}

function sweepGuestGames(now: number) {
  guestGames.forEach((times, ip) => {
    if (times.every(t => now - t >= GUEST_GAME_WINDOW_MS)) guestGames.delete(ip);
  });
}

// ── Expiry ──────────────────────────────────────────────────────────

const EXPIRY_INTERVAL_MS = 10 * 60 * 1000;

export async function runGuestPrizeExpiry(store: GuestPrizeStore): Promise<void> {
  try {
    const count = await store.expireDue();
    if (count > 0) console.log('[guest-prize] expired ' + count + ' unclaimed prize(s); the OREN stays in the treasury');
  } catch (err) {
    console.error('[guest-prize] expiry job failed:', err);
  }
}

export function startGuestPrizeJobs(store: GuestPrizeStore): NodeJS.Timeout {
  void runGuestPrizeExpiry(store);
  const timer = setInterval(() => {
    void runGuestPrizeExpiry(store);
    sweepGuestGames(Date.now());
  }, EXPIRY_INTERVAL_MS);
  timer.unref();
  return timer;
}

// ── Paying a claimed prize ──────────────────────────────────────────

const UNCONFIRMED_PREFIX = 'unconfirmed: ';

type PayOutcome = { ok: true; txSignature: string } | { ok: false };

async function payAndRecord(deps: GuestPrizeDeps, id: string, wallet: string, amountOren: number, roomCode: string | null): Promise<PayOutcome> {
  const result = await deps.payout(wallet, amountOren, roomCode ?? 'guest');
  // The transfer is done either way from here. A failed status write must
  // never report a sent prize as failed, or an admin could pay it twice. The
  // row stays 'claimed', which nothing re-pays automatically.
  try {
    if (result.ok) {
      await deps.store.markPaid(id, result.txSignature);
    } else {
      const text = (result.unconfirmed ? UNCONFIRMED_PREFIX : '') + result.error;
      await deps.store.markPayoutFailed(id, text.slice(0, 500));
    }
  } catch (err) {
    console.error('[guest-prize] payout finished but status not saved, prize ' + id + ', tx ' + (result.ok ? result.txSignature : 'none') + ':', err);
  }
  return result.ok ? { ok: true, txSignature: result.txSignature } : { ok: false };
}

// ── HTTP: the website's claim flow ──────────────────────────────────

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 10_000;
// 32 random bytes in base64url is always 43 characters.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Handler = (req: Request, res: Response) => Promise<void>;

// Express 4 doesn't catch errors from async handlers.
function safely(handler: Handler): Handler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[guest-prize] ' + req.method + ' request failed:', err);
      if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    }
  };
}

function isExpired(row: Pick<GuestPrizeRow, 'status' | 'expires_at'>): boolean {
  return row.status === 'expired' || (row.status === 'pending' && new Date(row.expires_at).getTime() <= Date.now());
}

export function createGuestPrizeRouter(deps: GuestPrizeDeps): Router {
  const router = Router();
  // One-time wallet challenges, per account + prize. Kept in this process,
  // like the rest of the server's live state: a restart only means asking
  // for a new challenge.
  const challenges = new Map<string, { message: string; expiresAt: number }>();

  function rememberChallenge(key: string, message: string) {
    const now = Date.now();
    challenges.forEach((c, k) => {
      if (c.expiresAt <= now) challenges.delete(k);
    });
    if (challenges.size >= MAX_CHALLENGES) {
      const oldest = challenges.keys().next().value;
      if (oldest !== undefined) challenges.delete(oldest);
    }
    challenges.set(key, { message, expiresAt: now + CHALLENGE_TTL_MS });
  }

  // Same token rules as the WebSocket 'identify' message.
  async function authenticatedUser(req: Request): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice(7);
    if (token.length < 20 || token.length > 4096) return null;
    return deps.userIdFromToken(token);
  }

  router.get('/:token', safely(async (req, res) => {
    const row = TOKEN_RE.test(req.params.token) ? await deps.store.findByTokenHash(hashClaimToken(req.params.token)) : null;
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      amountOren: Number(row.amount_oren),
      expiresAt: new Date(row.expires_at).toISOString(),
      status: isExpired(row) ? 'expired' : row.status,
    });
  }));

  router.post('/:token/challenge', safely(async (req, res) => {
    const userId = await authenticatedUser(req);
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const tokenHash = hashClaimToken(req.params.token);
    const row = TOKEN_RE.test(req.params.token) ? await deps.store.findByTokenHash(tokenHash) : null;
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (isExpired(row)) {
      res.status(410).json({ error: 'expired' });
      return;
    }
    if (row.status !== 'pending') {
      res.status(409).json({ error: 'already_claimed' });
      return;
    }
    const message = challengeMessage(randomBytes(16).toString('hex'));
    rememberChallenge(userId + ':' + tokenHash, message);
    res.json({ message });
  }));

  router.post('/:token/claim', safely(async (req, res) => {
    // 1. Who is claiming.
    const userId = await authenticatedUser(req);
    if (!userId) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // 2. Proof of the wallet, using the same checks as set_wallet. The
    // challenge is deleted before anything is awaited, so it is one-use even
    // when two requests arrive together.
    const tokenHash = hashClaimToken(req.params.token);
    const key = userId + ':' + tokenHash;
    const body = (req.body ?? {}) as { walletAddress?: unknown; signature?: unknown };
    const wallet = cleanWallet(body.walletAddress);
    const challenge = challenges.get(key);
    if (
      !wallet ||
      !challenge ||
      challenge.expiresAt <= Date.now() ||
      (!verifyWalletSignature(wallet, challenge.message, body.signature) &&
        !verifyFarcasterBase64Quirk(wallet, challenge.message, body.signature))
    ) {
      res.status(400).json({ error: 'bad_signature' });
      return;
    }
    challenges.delete(key);

    // 3. One claim per account and per wallet, ever. The unique indexes
    // enforce this too; checking here gives a clear answer first.
    const existing = await deps.store.findExistingClaims(userId, wallet);
    if (existing.some(r => r.token_hash === tokenHash)) {
      res.status(409).json({ error: 'already_claimed' });
      return;
    }
    if (existing.some(r => r.user_id === userId)) {
      res.status(409).json({ error: 'account_already_claimed' });
      return;
    }
    if (existing.length > 0) {
      res.status(409).json({ error: 'wallet_already_claimed' });
      return;
    }

    // 4. Claim atomically: of any parallel requests, only one gets a row.
    const claimed = await deps.store.claim(tokenHash, userId, wallet);
    if (claimed.result === 'account_already_claimed' || claimed.result === 'wallet_already_claimed') {
      res.status(409).json({ error: claimed.result });
      return;
    }
    if (claimed.result !== 'claimed') {
      const row = await deps.store.findByTokenHash(tokenHash);
      if (!row) res.status(404).json({ error: 'not_found' });
      else if (isExpired(row)) res.status(410).json({ error: 'expired' });
      else res.status(409).json({ error: 'already_claimed' });
      return;
    }

    // 5 and 6. Pay, and record the result. A failure is never re-paid automatically.
    const amountOren = Number(claimed.amount_oren);
    const paid = await payAndRecord(deps, claimed.id, wallet, amountOren, claimed.room_code);
    if (!paid.ok) {
      res.status(502).json({ error: 'payout_failed' });
      return;
    }
    res.json({ status: 'paid', txSignature: paid.txSignature, amountOren });
  }));

  return router;
}

// ── HTTP: admin (mounted behind the existing admin auth) ────────────

export function createGuestPrizeAdminRouter(deps: GuestPrizeDeps): Router {
  const router = Router();

  router.get('/', safely(async (req, res) => {
    const raw = req.query.status;
    if (raw !== undefined && raw !== '' && !GUEST_PRIZE_STATUSES.includes(raw as GuestPrizeStatus)) {
      res.status(400).json({ error: 'bad_status' });
      return;
    }
    const status = raw ? (raw as GuestPrizeStatus) : null;
    res.json({ prizes: await deps.store.list(status, 200) });
  }));

  router.post('/:id/retry-payout', safely(async (req, res) => {
    const row = UUID_RE.test(req.params.id) ? await deps.store.findById(req.params.id) : null;
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (row.status !== 'payout_failed' || !row.wallet_address) {
      res.status(409).json({ error: 'not_retryable' });
      return;
    }
    // The first attempt may really have landed, so retrying could pay twice.
    // An admin must check the chain first, then send { "force": true }.
    const force = (req.body as { force?: unknown } | undefined)?.force === true;
    if (row.payout_error?.startsWith(UNCONFIRMED_PREFIX) && !force) {
      res.status(409).json({ error: 'payout_unconfirmed' });
      return;
    }
    // Atomic, so two retries at once can't both pay.
    if (!(await deps.store.beginRetry(row.id))) {
      res.status(409).json({ error: 'not_retryable' });
      return;
    }
    const amountOren = Number(row.amount_oren);
    const paid = await payAndRecord(deps, row.id, row.wallet_address, amountOren, row.room_code);
    if (!paid.ok) {
      res.status(502).json({ error: 'payout_failed' });
      return;
    }
    res.json({ status: 'paid', txSignature: paid.txSignature, amountOren });
  }));

  return router;
}
