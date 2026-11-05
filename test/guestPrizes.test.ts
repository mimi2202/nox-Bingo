import './setupEnv';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'crypto';
import { AddressInfo } from 'net';
import { Server } from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { PublicKey } from '@solana/web3.js';
import { PGlite } from '@electric-sql/pglite';
import { createPgliteStore, createTestDb } from './pgliteStore';
import {
  allowGuestGame,
  awardGuestPrize,
  createGuestPrizeAdminRouter,
  createGuestPrizeRouter,
  GuestPrizeDeps,
  hashClaimToken,
  HeldGuestPrizes,
  loadGuestPrizeSettings,
  PayoutResult,
  runGuestPrizeExpiry,
} from '../src/guestPrizes';
import { GuestPrizeStore } from '../src/guestPrizeStore';
import { getConfig } from '../src/gameConfig';
import { requireAdminAuth } from '../src/admin';
import {
  createRoom,
  getPayoutAmount,
  isPracticeRoom,
  leaveRoom,
  markEntryFeePaid,
  markPracticeRoom,
  setWallet,
  singleCardSoloPrize,
  toPayableOren,
} from '../src/RoomManager';

// ── Helpers ─────────────────────────────────────────────────────────

const USER_A = randomUUID();
const USER_B = randomUUID();
const USER_C = randomUUID();
const TOKENS: Record<string, string> = {
  'access-token-for-user-a': USER_A,
  'access-token-for-user-b': USER_B,
  'access-token-for-user-c': USER_C,
};
const A = 'access-token-for-user-a';
const B = 'access-token-for-user-b';
const C = 'access-token-for-user-c';

function newWallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    address: new PublicKey(raw).toBase58(),
    signText: (message: string) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
    // What Farcaster's wallet really signs: the text read as base64.
    signFarcaster: (message: string) => sign(null, Buffer.from(message, 'base64'), privateKey).toString('base64'),
  };
}

let db: PGlite;
let store: GuestPrizeStore;
let server: Server;
let base: string;
let payments: { wallet: string; amount: number }[];
let payoutResult: () => Promise<PayoutResult>;
let activeStore: GuestPrizeStore;

const settings = { enabled: true, ttlHours: 48, dailyBudgetOren: 500 };

function makeDeps(overrides: Partial<GuestPrizeDeps> = {}): GuestPrizeDeps {
  return {
    settings,
    // Looked up per call so one test can swap in a failing store.
    store: new Proxy({} as GuestPrizeStore, { get: (_t, prop) => activeStore[prop as keyof GuestPrizeStore] }),
    prizeAmount: () => singleCardSoloPrize(getConfig()),
    userIdFromToken: async t => TOKENS[t] ?? null,
    payout: async (wallet, amount) => {
      payments.push({ wallet, amount });
      return payoutResult();
    },
    ...overrides,
  };
}

// Plays out a guest win and returns what the winning socket received.
async function win(ip = '1.1.1.1', deps = makeDeps(), isRoomOpen = true) {
  const sent: any[] = [];
  await awardGuestPrize(deps, {
    roomCode: 'ROOM01',
    ip,
    isRoomOpen: () => isRoomOpen,
    deliver: m => sent.push(m),
  });
  return sent;
}

let nextIp = 100;
async function newPrizeToken(): Promise<string> {
  const [msg] = await win('10.0.0.' + nextIp++);
  assert.equal(msg.type, 'guest_prize');
  return msg.claimToken;
}

async function allRows() {
  return (await db.query<any>('select * from guest_prizes order by created_at')).rows;
}

function post(path: string, bearer: string | null, body?: object) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

async function challenge(token: string, bearer: string): Promise<string> {
  const res = await post(`/guest-prize/${token}/challenge`, bearer);
  assert.equal(res.status, 200);
  return ((await res.json()) as { message: string }).message;
}

async function claim(token: string, bearer: string, wallet = newWallet()) {
  const message = await challenge(token, bearer);
  return post(`/guest-prize/${token}/claim`, bearer, { walletAddress: wallet.address, signature: wallet.signText(message) });
}

async function expectError(res: Response, status: number, code: string) {
  assert.equal(res.status, status);
  assert.deepEqual(await res.json(), { error: code });
}

const ADMIN = jwt.sign({ role: 'admin' }, process.env.ADMIN_JWT_SECRET as string, { algorithm: 'HS256' });

before(async () => {
  db = await createTestDb();
  store = createPgliteStore(db);
  for (const id of [USER_A, USER_B, USER_C]) await db.query('insert into auth.users(id) values ($1)', [id]);

  const app = express();
  app.use(express.json());
  const deps = makeDeps();
  app.use('/guest-prize', createGuestPrizeRouter(deps));
  app.use('/admin/guest-prizes', requireAdminAuth, createGuestPrizeAdminRouter(deps));
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
});

beforeEach(async () => {
  await db.exec('delete from guest_prizes');
  activeStore = store;
  payments = [];
  payoutResult = async () => ({ ok: true, txSignature: 'tx-' + randomUUID() });
});

// ── Creating a prize ────────────────────────────────────────────────

describe('a guest win', () => {
  it('creates exactly one pending prize and sends guest_prize to the winner', async () => {
    const sent = await win();
    assert.equal(sent.length, 1);
    const msg = sent[0];
    assert.equal(msg.type, 'guest_prize');
    assert.equal(msg.amountOren, 35);
    assert.equal(Buffer.from(msg.claimToken, 'base64url').length, 32);

    const hoursLeft = (new Date(msg.expiresAt).getTime() - Date.now()) / 3_600_000;
    assert.ok(hoursLeft > 47.9 && hoursLeft <= 48, 'expires in 48 hours, got ' + hoursLeft);

    const rows = await allRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].guest_ip, '1.1.1.1');
    assert.equal(rows[0].room_code, 'ROOM01');
    // Only the hash is stored.
    assert.equal(rows[0].token_hash, hashClaimToken(msg.claimToken));
    assert.ok(!JSON.stringify(rows[0]).includes(msg.claimToken));
  });

  it('gets no second prize from the same IP while one is pending', async () => {
    await win('2.2.2.2');
    assert.deepEqual(await win('2.2.2.2'), [{ type: 'guest_prize_unavailable', reason: 'limit_reached' }]);
    assert.equal((await allRows()).length, 1);
    assert.equal((await win('3.3.3.3'))[0].type, 'guest_prize');
  });

  it('allows two wins at the same moment from one IP to create only one prize', async () => {
    const results = await Promise.all([win('2.2.2.2'), win('2.2.2.2'), win('2.2.2.2')]);
    assert.equal(results.filter(r => r[0].type === 'guest_prize').length, 1);
    assert.equal((await allRows()).length, 1);
  });

  it('can win again once the earlier prize has expired, even before the job runs', async () => {
    await win('2.2.2.2');
    await db.exec(`update guest_prizes set expires_at = now() - interval '1 minute'`);
    assert.equal((await win('2.2.2.2'))[0].type, 'guest_prize');
  });

  it('can win again from the same IP after claiming', async () => {
    const [msg] = await win('2.2.2.2');
    assert.equal((await claim(msg.claimToken, A)).status, 200);
    assert.equal((await win('2.2.2.2'))[0].type, 'guest_prize');
  });

  it('withdraws the prize if the room closed before it could be delivered', async () => {
    assert.deepEqual(await win('2.2.2.2', makeDeps(), false), []);
    assert.equal((await allRows())[0].status, 'expired');
    assert.equal((await win('2.2.2.2'))[0].type, 'guest_prize');
  });

  it('reports no prize, rather than crashing, when the database fails', async () => {
    activeStore = { ...store, create: async () => { throw new Error('db down'); } };
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(await win(), [{ type: 'guest_prize_unavailable', reason: 'limit_reached' }]);
    } finally {
      console.error = originalError;
    }
  });

  it('never logs the claim token', async () => {
    const logged: string[] = [];
    const originals = { log: console.log, error: console.error, warn: console.warn };
    for (const k of ['log', 'error', 'warn'] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
    try {
      const [msg] = await win('2.2.2.2');
      payoutResult = async () => ({ ok: false, unconfirmed: false, error: 'boom' });
      await claim(msg.claimToken, A);
      assert.ok(!logged.join('\n').includes(msg.claimToken));
      assert.ok(!logged.join('\n').includes(hashClaimToken(msg.claimToken)));
    } finally {
      Object.assign(console, originals);
    }
  });
});

describe('a winner who is away', () => {
  async function pendingPrize() {
    const [message] = await win('2.2.2.2');
    return { message, id: (await allRows())[0].id as string };
  }
  const status = async () => (await allRows())[0].status;

  it('keeps the prize and gets it on reconnecting', async () => {
    const { message, id } = await pendingPrize();
    const held = new HeldGuestPrizes(store);
    held.deliver('R1', message, id, () => false);
    assert.equal(await status(), 'pending');

    const received: object[] = [];
    held.resend('R1', m => received.push(m));
    assert.deepEqual(received, [message]);

    await held.roomClosed('R1');
    assert.equal(await status(), 'pending');
  });

  it('gets it again on a later reconnect, as the website rebuilds from a replay', async () => {
    const { message, id } = await pendingPrize();
    const held = new HeldGuestPrizes(store);
    held.deliver('R1', message, id, () => true);
    const received: object[] = [];
    held.resend('R1', m => received.push(m));
    held.resend('R1', m => received.push(m));
    assert.deepEqual(received, [message, message]);
  });

  it('keeps a delivered prize when the room closes', async () => {
    const { message, id } = await pendingPrize();
    const held = new HeldGuestPrizes(store);
    held.deliver('R1', message, id, () => true);
    await held.roomClosed('R1');
    assert.equal(await status(), 'pending');
  });

  it('withdraws a prize that never reached them once the room closes', async () => {
    const { message, id } = await pendingPrize();
    const held = new HeldGuestPrizes(store);
    held.deliver('R1', message, id, () => false);
    await held.roomClosed('R1');
    assert.equal(await status(), 'expired');
    // Nothing is left to send, and the guest can win a prize again.
    const received: object[] = [];
    held.resend('R1', m => received.push(m));
    assert.deepEqual(received, []);
    assert.equal((await win('2.2.2.2'))[0].type, 'guest_prize');
  });

  it('does not withdraw a claimed prize if the room closes afterwards', async () => {
    const { message, id } = await pendingPrize();
    const held = new HeldGuestPrizes(store);
    held.deliver('R1', message, id, () => false);
    await db.exec(`update guest_prizes set status='paid'`);
    await held.roomClosed('R1');
    assert.equal(await status(), 'paid');
  });

  it('also gets a "no prize" answer on reconnecting', async () => {
    const held = new HeldGuestPrizes(store);
    const message = { type: 'guest_prize_unavailable', reason: 'daily_budget' };
    held.deliver('R1', message, null, () => false);
    const received: object[] = [];
    held.resend('R1', m => received.push(m));
    assert.deepEqual(received, [message]);
    await held.roomClosed('R1');
  });
});

describe('the prize amount', () => {
  // A real paid 1-card solo game under the current config.
  function paidSoloWin(): number {
    const pid = randomUUID();
    const wallet = newWallet().address;
    const { room } = createRoom(pid, 'Paid', null, 1, true);
    setWallet(pid, wallet);
    const { room: paid } = markEntryFeePaid(pid, 'single', 'OREN', room.code, wallet);
    assert.ok(paid);
    assert.equal(isPracticeRoom(room.code), false);
    const amount = toPayableOren(getPayoutAmount(room, pid));
    leaveRoom(pid);
    return amount;
  }

  it('is 35 OREN with the default config, the same as a paid 1-card solo win', () => {
    assert.equal(singleCardSoloPrize(getConfig()), 35);
    assert.equal(paidSoloWin(), 35);
  });

  it('follows the live bundle price and rate, exactly as a paid win does', async () => {
    const config = getConfig();
    const bundle = config.bundles.find(b => b.id === 'single')!;
    const saved = { price: bundle.priceGBP, rate: config.orenToGbpRate, mult: config.soloMultipliers.single };
    try {
      for (const [price, rate, mult] of [[7, 1.5, 15], [3.5, 2, 15], [3.5, 1.5, 9], [4.99, 1.37, 12.5]]) {
        bundle.priceGBP = price;
        config.orenToGbpRate = rate;
        config.soloMultipliers.single = mult;
        assert.equal(singleCardSoloPrize(config), paidSoloWin(), `price ${price} rate ${rate} multiplier ${mult}`);
      }
      bundle.priceGBP = 7;
      config.orenToGbpRate = 1.5;
      config.soloMultipliers.single = 15;
      const [msg] = await win();
      assert.equal(msg.amountOren, 70);
    } finally {
      bundle.priceGBP = saved.price;
      config.orenToGbpRate = saved.rate;
      config.soloMultipliers.single = saved.mult;
    }
  });

  it('gives no prize if the live config has no single-card bundle', async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal(singleCardSoloPrize({ ...getConfig(), bundles: [] }), null);
      const sent = await win('1.1.1.1', makeDeps({ prizeAmount: () => null }));
      assert.deepEqual(sent, [{ type: 'guest_prize_unavailable', reason: 'limit_reached' }]);
      assert.equal((await allRows()).length, 0);
    } finally {
      console.error = originalError;
    }
  });
});

describe('the daily budget', () => {
  async function winMany(count: number) {
    return Promise.all(Array.from({ length: count }, (_, i) => win('20.0.0.' + nextIp++ + i)));
  }

  it('stops prizes once 500 OREN is reached: 14 x 35 fits, the 15th does not', async () => {
    const results = await winMany(14);
    assert.ok(results.every(r => r[0].type === 'guest_prize'));
    assert.deepEqual(await win('9.9.9.9'), [{ type: 'guest_prize_unavailable', reason: 'daily_budget' }]);
    const total = (await allRows()).reduce((s, r) => s + Number(r.amount_oren), 0);
    assert.equal(total, 490);
  });

  it('holds when many wins arrive at the same moment', async () => {
    const results = await winMany(30);
    assert.equal(results.filter(r => r[0].type === 'guest_prize').length, 14);
    assert.equal(results.filter(r => r[0].reason === 'daily_budget').length, 16);
  });

  it('allows a win that lands exactly on the limit', async () => {
    const deps = makeDeps({ prizeAmount: () => 250 });
    assert.equal((await win('5.5.5.1', deps))[0].type, 'guest_prize');
    assert.equal((await win('5.5.5.2', deps))[0].type, 'guest_prize');
    assert.equal((await win('5.5.5.3', deps))[0].reason, 'daily_budget');
  });

  it('does not count expired prizes', async () => {
    await winMany(14);
    await db.exec(`update guest_prizes set status='expired'`);
    assert.equal((await win('9.9.9.9'))[0].type, 'guest_prize');
  });

  it('does not count pending prizes past their time, even before the job runs', async () => {
    await winMany(14);
    await db.exec(`update guest_prizes set expires_at = now() - interval '1 minute'`);
    assert.equal((await win('9.9.9.9'))[0].type, 'guest_prize');
  });

  it('counts claimed, paid and failed payouts', async () => {
    await winMany(14);
    await db.exec(`
      with numbered as (select id, row_number() over () as n from guest_prizes)
      update guest_prizes g set status = (array['claimed','paid','payout_failed'])[(n.n % 3) + 1]
        from numbered n where n.id = g.id`);
    assert.equal((await win('9.9.9.9'))[0].reason, 'daily_budget');
  });

  it('resets at the start of the UTC day', async () => {
    await winMany(14);
    await db.exec(`update guest_prizes set created_at = date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '1 second'`);
    assert.equal((await win('9.9.9.9'))[0].type, 'guest_prize');
  });
});

describe('with GUEST_PRIZE_ENABLED off', () => {
  it('is the default, and nothing happens on a win', async () => {
    assert.equal(loadGuestPrizeSettings({}).enabled, false);
    assert.equal(loadGuestPrizeSettings({ GUEST_PRIZE_ENABLED: 'TRUE ' }).enabled, false);
    const explode = new Proxy({} as GuestPrizeStore, { get: () => { throw new Error('must not touch the store'); } });
    const deps = makeDeps({ settings: { ...settings, enabled: false }, store: explode });
    assert.deepEqual(await win('1.1.1.1', deps), []);
  });

  it('leaves a practice game paying nothing and a paid game unchanged', () => {
    const guest = randomUUID();
    const { room: practice } = createRoom(guest, 'Guest', null, 1, true);
    markPracticeRoom(practice);
    assert.equal(getPayoutAmount(practice, guest), 0);
    leaveRoom(guest);

    const pid = randomUUID();
    const wallet = newWallet().address;
    const { room } = createRoom(pid, 'Paid', null, 1, true);
    setWallet(pid, wallet);
    markEntryFeePaid(pid, 'triple', 'OREN', room.code, wallet);
    assert.equal(toPayableOren(getPayoutAmount(room, pid)), 36);
    leaveRoom(pid);
  });
});

describe('settings', () => {
  it('reads the three env vars and falls back to the brief’s values', () => {
    assert.deepEqual(loadGuestPrizeSettings({ GUEST_PRIZE_ENABLED: 'true', GUEST_PRIZE_TTL_HOURS: '24', GUEST_PRIZE_DAILY_BUDGET_OREN: '100' }), {
      enabled: true, ttlHours: 24, dailyBudgetOren: 100,
    });
    assert.deepEqual(loadGuestPrizeSettings({ GUEST_PRIZE_TTL_HOURS: 'soon', GUEST_PRIZE_DAILY_BUDGET_OREN: '-5' }), {
      enabled: false, ttlHours: 48, dailyBudgetOren: 500,
    });
  });
});

describe('guest game rate limit', () => {
  it('allows 20 per hour per IP', () => {
    const t = 1_000_000_000_000;
    for (let i = 0; i < 20; i++) assert.equal(allowGuestGame('7.7.7.7', t + i), true);
    assert.equal(allowGuestGame('7.7.7.7', t + 100), false);
    assert.equal(allowGuestGame('7.7.7.8', t + 100), true);
    assert.equal(allowGuestGame('7.7.7.7', t + 60 * 60 * 1000 + 100), true);
  });
});

// ── Viewing a prize ─────────────────────────────────────────────────

describe('GET /guest-prize/:token', () => {
  it('shows a pending prize without sign-in', async () => {
    const [msg] = await win();
    const res = await fetch(`${base}/guest-prize/${msg.claimToken}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { amountOren: 35, expiresAt: msg.expiresAt, status: 'pending' });
  });

  it('returns 404 for an unknown or malformed token', async () => {
    await expectError(await fetch(`${base}/guest-prize/${'x'.repeat(43)}`), 404, 'not_found');
    await expectError(await fetch(`${base}/guest-prize/short`), 404, 'not_found');
  });

  it('shows expired prizes as expired, even before the job has run', async () => {
    const [msg] = await win();
    await db.exec(`update guest_prizes set expires_at = now() - interval '1 minute'`);
    const body = (await (await fetch(`${base}/guest-prize/${msg.claimToken}`)).json()) as { status: string };
    assert.equal(body.status, 'expired');
  });
});

// ── Claiming ────────────────────────────────────────────────────────

describe('claiming', () => {
  it('pays the prize to the signed wallet and records it', async () => {
    const token = await newPrizeToken();
    const wallet = newWallet();
    const res = await claim(token, A, wallet);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; txSignature: string; amountOren: number };
    assert.equal(body.status, 'paid');
    assert.equal(body.amountOren, 35);
    assert.deepEqual(payments, [{ wallet: wallet.address, amount: 35 }]);

    const [row] = await allRows();
    assert.equal(row.status, 'paid');
    assert.equal(row.user_id, USER_A);
    assert.equal(row.wallet_address, wallet.address);
    assert.equal(row.payout_tx, body.txSignature);
    assert.ok(row.claimed_at);
  });

  it('accepts the Farcaster wallet’s signature form, as set_wallet does', async () => {
    const token = await newPrizeToken();
    const wallet = newWallet();
    const message = await challenge(token, A);
    const res = await post(`/guest-prize/${token}/claim`, A, { walletAddress: wallet.address, signature: wallet.signFarcaster(message) });
    assert.equal(res.status, 200);
  });

  it('rejects a missing or bad login with 401', async () => {
    const token = await newPrizeToken();
    await expectError(await post(`/guest-prize/${token}/challenge`, null), 401, 'unauthorized');
    await expectError(await post(`/guest-prize/${token}/challenge`, 'not-a-real-access-token'), 401, 'unauthorized');
    await expectError(await post(`/guest-prize/${token}/claim`, null, {}), 401, 'unauthorized');
    await expectError(await post(`/guest-prize/${token}/claim`, 'not-a-real-access-token', {}), 401, 'unauthorized');
    assert.equal(payments.length, 0);
  });

  it('rejects a bad signature with 400, and leaves the prize claimable', async () => {
    const token = await newPrizeToken();
    const wallet = newWallet();
    const message = await challenge(token, A);
    const path = `/guest-prize/${token}/claim`;

    // Signed by a different wallet.
    await expectError(await post(path, A, { walletAddress: wallet.address, signature: newWallet().signText(message) }), 400, 'bad_signature');
    // The right wallet, the wrong text.
    await expectError(await post(path, A, { walletAddress: wallet.address, signature: wallet.signText('something else') }), 400, 'bad_signature');
    await expectError(await post(path, A, { walletAddress: wallet.address, signature: 'bm90IGEgc2lnbmF0dXJl' }), 400, 'bad_signature');
    await expectError(await post(path, A, { walletAddress: wallet.address }), 400, 'bad_signature');
    await expectError(await post(path, A, { walletAddress: 'not-a-wallet', signature: wallet.signText(message) }), 400, 'bad_signature');

    assert.equal((await allRows())[0].status, 'pending');
    assert.equal(payments.length, 0);
    const good = await post(path, A, { walletAddress: wallet.address, signature: wallet.signText(message) });
    assert.equal(good.status, 200);
  });

  it('rejects a signature made for someone else’s challenge', async () => {
    const token = await newPrizeToken();
    const wallet = newWallet();
    await challenge(token, A);
    const messageB = await challenge(token, B);
    await expectError(
      await post(`/guest-prize/${token}/claim`, A, { walletAddress: wallet.address, signature: wallet.signText(messageB) }),
      400,
      'bad_signature'
    );
  });

  it('rejects a claim with no challenge', async () => {
    const token = await newPrizeToken();
    const wallet = newWallet();
    await expectError(await post(`/guest-prize/${token}/claim`, A, { walletAddress: wallet.address, signature: wallet.signText('x') }), 400, 'bad_signature');
  });

  it('rejects a reused signature with 400', async () => {
    const token = await newPrizeToken();
    const wallet = newWallet();
    const message = await challenge(token, A);
    const body = { walletAddress: wallet.address, signature: wallet.signText(message) };
    assert.equal((await post(`/guest-prize/${token}/claim`, A, body)).status, 200);
    await expectError(await post(`/guest-prize/${token}/claim`, A, body), 400, 'bad_signature');
    assert.equal(payments.length, 1);
  });

  it('refuses an expired prize with 410, even before the job has run', async () => {
    const token = await newPrizeToken();
    const wallet = newWallet();
    const message = await challenge(token, A);
    await db.exec(`update guest_prizes set expires_at = now() - interval '1 minute'`);
    await expectError(await post(`/guest-prize/${token}/challenge`, A), 410, 'expired');
    await expectError(
      await post(`/guest-prize/${token}/claim`, A, { walletAddress: wallet.address, signature: wallet.signText(message) }),
      410,
      'expired'
    );
    assert.equal(payments.length, 0);
    assert.equal((await allRows())[0].status, 'pending');
  });

  it('returns 404 at the challenge for an unknown token', async () => {
    await expectError(await post(`/guest-prize/${'x'.repeat(43)}/challenge`, A), 404, 'not_found');
  });

  it('refuses a second claim on the same token with 409', async () => {
    const token = await newPrizeToken();
    const wallet = newWallet();
    const messageB = await challenge(token, B);
    assert.equal((await claim(token, A)).status, 200);
    // At the challenge...
    await expectError(await post(`/guest-prize/${token}/challenge`, C), 409, 'already_claimed');
    // ...and with a challenge obtained before the first claim landed.
    await expectError(
      await post(`/guest-prize/${token}/claim`, B, { walletAddress: wallet.address, signature: wallet.signText(messageB) }),
      409,
      'already_claimed'
    );
    assert.equal(payments.length, 1);
  });

  it('allows one claim per account, ever', async () => {
    const first = await newPrizeToken();
    const second = await newPrizeToken();
    assert.equal((await claim(first, A)).status, 200);
    await expectError(await claim(second, A), 409, 'account_already_claimed');
    assert.equal(payments.length, 1);
    assert.equal((await store.findByTokenHash(hashClaimToken(second)))?.status, 'pending');
  });

  it('allows one claim per wallet, ever', async () => {
    const first = await newPrizeToken();
    const second = await newPrizeToken();
    const wallet = newWallet();
    assert.equal((await claim(first, A, wallet)).status, 200);
    await expectError(await claim(second, B, wallet), 409, 'wallet_already_claimed');
    assert.equal(payments.length, 1);
  });

  it('counts a failed payout as the account’s and wallet’s one claim', async () => {
    const first = await newPrizeToken();
    const second = await newPrizeToken();
    const wallet = newWallet();
    payoutResult = async () => ({ ok: false, unconfirmed: false, error: 'boom' });
    await expectError(await claim(first, A, wallet), 502, 'payout_failed');
    await expectError(await claim(second, A), 409, 'account_already_claimed');
    await expectError(await claim(second, B, wallet), 409, 'wallet_already_claimed');
  });

  it('has the database reject a duplicate account or wallet that gets past the first check', async () => {
    const hashes = [hashClaimToken(await newPrizeToken()), hashClaimToken(await newPrizeToken()), hashClaimToken(await newPrizeToken())];
    const wallet = newWallet().address;
    assert.equal((await store.claim(hashes[0], USER_A, wallet)).result, 'claimed');
    assert.equal((await store.claim(hashes[1], USER_A, newWallet().address)).result, 'account_already_claimed');
    assert.equal((await store.claim(hashes[2], USER_B, wallet)).result, 'wallet_already_claimed');
    const rows = await allRows();
    assert.equal(rows.filter(r => r.status === 'claimed').length, 1);
    assert.equal(rows.filter(r => r.status === 'pending').length, 2);
  });
});

describe('parallel claims', () => {
  it('pays exactly once when different accounts claim one token together', async () => {
    const token = await newPrizeToken();
    const bodies = [];
    for (const bearer of [A, B, C]) {
      const wallet = newWallet();
      const message = await challenge(token, bearer);
      bodies.push({ bearer, body: { walletAddress: wallet.address, signature: wallet.signText(message) } });
    }
    const results = await Promise.all(bodies.map(b => post(`/guest-prize/${token}/claim`, b.bearer, b.body)));
    const statuses = results.map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409]);
    assert.equal(payments.length, 1);
  });

  it('pays exactly once when one account sends the same claim repeatedly', async () => {
    const token = await newPrizeToken();
    const wallet = newWallet();
    const message = await challenge(token, A);
    const body = { walletAddress: wallet.address, signature: wallet.signText(message) };
    const results = await Promise.all(Array.from({ length: 5 }, () => post(`/guest-prize/${token}/claim`, A, body)));
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal(payments.length, 1);
  });

  it('pays exactly once when one account claims two tokens together', async () => {
    const tokens = [await newPrizeToken(), await newPrizeToken()];
    const results = await Promise.all(tokens.map(t => claim(t, A)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(payments.length, 1);
  });

  it('pays exactly once when one wallet claims two tokens together', async () => {
    const tokens = [await newPrizeToken(), await newPrizeToken()];
    const wallet = newWallet();
    const results = await Promise.all([claim(tokens[0], A, wallet), claim(tokens[1], B, wallet)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(payments.length, 1);
  });
});

describe('payout failure', () => {
  it('returns 502, records the failure and does not re-pay on its own', async () => {
    const token = await newPrizeToken();
    payoutResult = async () => ({ ok: false, unconfirmed: false, error: 'treasury empty' });
    await expectError(await claim(token, A), 502, 'payout_failed');
    const [row] = await allRows();
    assert.equal(row.status, 'payout_failed');
    assert.equal(row.payout_error, 'treasury empty');
    assert.equal(payments.length, 1);
    // Trying again from the website doesn't pay again.
    await expectError(await post(`/guest-prize/${token}/challenge`, A), 409, 'already_claimed');
    assert.equal(payments.length, 1);
  });

  it('still reports success if the transfer went out but saving the status failed', async () => {
    const token = await newPrizeToken();
    activeStore = { ...store, markPaid: async () => { throw new Error('db down'); } };
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await claim(token, A);
      assert.equal(res.status, 200);
    } finally {
      console.error = originalError;
    }
    // Still 'claimed', never 'payout_failed', so an admin can't pay it twice.
    const [row] = await allRows();
    assert.equal(row.status, 'claimed');
    await expectError(await post(`/admin/guest-prizes/${row.id}/retry-payout`, ADMIN), 409, 'not_retryable');
    assert.equal(payments.length, 1);
  });
});

// ── Expiry ──────────────────────────────────────────────────────────

describe('the expiry job', () => {
  it('flips only overdue pending prizes and moves no money', async () => {
    const overdue = await newPrizeToken();
    const current = await newPrizeToken();
    const paid = await newPrizeToken();
    const failed = await newPrizeToken();
    assert.equal((await claim(paid, A)).status, 200);
    payoutResult = async () => ({ ok: false, unconfirmed: false, error: 'boom' });
    assert.equal((await claim(failed, B)).status, 502);
    payments = [];

    await db.query(`update guest_prizes set expires_at = now() - interval '1 minute' where token_hash = any($1)`, [
      [overdue, paid, failed].map(hashClaimToken),
    ]);
    await runGuestPrizeExpiry(store);

    const status = async (t: string) => (await store.findByTokenHash(hashClaimToken(t)))?.status;
    assert.equal(await status(overdue), 'expired');
    assert.equal(await status(current), 'pending');
    assert.equal(await status(paid), 'paid');
    assert.equal(await status(failed), 'payout_failed');
    assert.equal(payments.length, 0);
  });
});

// ── Admin ───────────────────────────────────────────────────────────

describe('admin', () => {
  const admin = (path: string) => fetch(base + path, { headers: { Authorization: 'Bearer ' + ADMIN } });

  async function failedPrize(error = 'boom', unconfirmed = false) {
    const token = await newPrizeToken();
    payoutResult = async () => ({ ok: false, unconfirmed, error });
    assert.equal((await claim(token, A)).status, 502);
    payoutResult = async () => ({ ok: true, txSignature: 'tx-retry' });
    payments = [];
    return (await allRows())[0].id as string;
  }

  it('needs the admin token', async () => {
    assert.equal((await fetch(`${base}/admin/guest-prizes`)).status, 401);
    assert.equal((await post(`/admin/guest-prizes/${randomUUID()}/retry-payout`, A)).status, 401);
  });

  it('lists prizes without token_hash, filtered by status', async () => {
    await newPrizeToken();
    await db.exec(`update guest_prizes set status='expired'`);
    await newPrizeToken();

    const all = (await (await admin('/admin/guest-prizes')).json()) as { prizes: any[] };
    assert.equal(all.prizes.length, 2);
    assert.ok(all.prizes.every(p => !('token_hash' in p)));

    const pending = (await (await admin('/admin/guest-prizes?status=pending')).json()) as { prizes: any[] };
    assert.equal(pending.prizes.length, 1);
    assert.equal(pending.prizes[0].status, 'pending');

    assert.equal((await admin('/admin/guest-prizes?status=nonsense')).status, 400);
  });

  it('retries a failed payout', async () => {
    const id = await failedPrize();
    const res = await post(`/admin/guest-prizes/${id}/retry-payout`, ADMIN);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'paid', txSignature: 'tx-retry', amountOren: 35 });
    assert.equal(payments.length, 1);
    const [row] = await allRows();
    assert.equal(row.status, 'paid');
    assert.equal(row.payout_tx, 'tx-retry');
    assert.equal(row.payout_error, null);
  });

  it('records a retry that fails too, and can retry again', async () => {
    const id = await failedPrize();
    payoutResult = async () => ({ ok: false, unconfirmed: false, error: 'still broken' });
    await expectError(await post(`/admin/guest-prizes/${id}/retry-payout`, ADMIN), 502, 'payout_failed');
    assert.equal((await allRows())[0].payout_error, 'still broken');
    payoutResult = async () => ({ ok: true, txSignature: 'tx-2' });
    assert.equal((await post(`/admin/guest-prizes/${id}/retry-payout`, ADMIN)).status, 200);
  });

  it('pays once when two retries arrive together', async () => {
    const id = await failedPrize();
    const results = await Promise.all([1, 2, 3].map(() => post(`/admin/guest-prizes/${id}/retry-payout`, ADMIN)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409]);
    assert.equal(payments.length, 1);
  });

  it('refuses to retry an unconfirmed transfer unless forced, as it may have landed', async () => {
    const id = await failedPrize('Transaction was not confirmed in 30 seconds', true);
    assert.ok((await allRows())[0].payout_error.startsWith('unconfirmed: '));
    await expectError(await post(`/admin/guest-prizes/${id}/retry-payout`, ADMIN), 409, 'payout_unconfirmed');
    assert.equal(payments.length, 0);
    assert.equal((await post(`/admin/guest-prizes/${id}/retry-payout`, ADMIN, { force: true })).status, 200);
    assert.equal(payments.length, 1);
  });

  it('only retries payout_failed rows', async () => {
    const token = await newPrizeToken();
    const id = (await allRows())[0].id;
    await expectError(await post(`/admin/guest-prizes/${id}/retry-payout`, ADMIN), 409, 'not_retryable');
    assert.equal((await claim(token, A)).status, 200);
    payments = [];
    await expectError(await post(`/admin/guest-prizes/${id}/retry-payout`, ADMIN), 409, 'not_retryable');
    await expectError(await post(`/admin/guest-prizes/${randomUUID()}/retry-payout`, ADMIN), 404, 'not_found');
    await expectError(await post(`/admin/guest-prizes/not-a-uuid/retry-payout`, ADMIN), 404, 'not_found');
    assert.equal(payments.length, 0);
  });
});

// ── Database access ─────────────────────────────────────────────────

describe('browser keys', () => {
  async function asRole(role: string, sql: string) {
    await db.exec(`set role ${role}`);
    try {
      return await db.query<any>(sql);
    } finally {
      await db.exec('reset role');
    }
  }

  for (const role of ['anon', 'authenticated']) {
    it(`${role} cannot read the table or call the functions`, async () => {
      await newPrizeToken();
      const denied = /permission denied/;
      await assert.rejects(asRole(role, 'select * from guest_prizes'), denied);
      await assert.rejects(asRole(role, `select create_guest_prize('x', 1, 'r', 'i', 1, 500)`), denied);
      await assert.rejects(asRole(role, `select claim_guest_prize('x', '${USER_A}', 'w')`), denied);
      await assert.rejects(asRole(role, 'select expire_guest_prizes()'), denied);
    });
  }

  it('the server’s service role can do its work', async () => {
    await newPrizeToken();
    assert.equal((await asRole('service_role', 'select * from guest_prizes')).rows.length, 1);
    assert.equal((await asRole('service_role', 'select expire_guest_prizes() as n')).rows[0].n, 0);
  });
});
