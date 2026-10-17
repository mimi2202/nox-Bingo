import http from 'http';
import express from 'express';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { PublicKey } from '@solana/web3.js';
import { ClientMessage, Room } from './types';
import { createRoom, joinRoom, leaveRoom, startGame, drawBall, getPlayerRoom, setWallet, markEntryFeePaid, removePlayer, roomEvents, getPayoutAmount, orenEquivalent, usdtEquivalent, isPracticeRoom, markPracticeRoom } from './RoomManager';
import { TREASURY_PUBLIC_KEY, payWinner, payJackpot, verifyEntryFeePayment, verifySolEntryFeePayment } from './solana';
import { getSolUsdPrice } from './pyth';
import { loadConfigFromDb } from './gameConfig';
import { adminRouter } from './admin';
import { randomBytes } from 'crypto';
import { challengeMessage, verifyWalletSignature } from './walletProof';
import { verifyFarcasterBase64Quirk } from './farcasterProof';
import { claimSignature, startPayoutRecord, finishPayoutRecord } from './usedSignatures';
import { userIdFromToken, recordGameResult } from './profileStats';

const PORT = parseInt(process.env.PORT || '3001');

// ── Abuse limits ───────────────────────────────────────────────────
// Game messages are tiny; anything bigger than this is not a real client.
const MAX_PAYLOAD_BYTES = 16 * 1024;
// Per connection: at most this many messages per window, else disconnected.
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 40;
// Per IP: simultaneous connections allowed.
const MAX_CONNECTIONS_PER_IP = 20;
// Dead-connection detection (mobile networks drop silently).
const HEARTBEAT_MS = 30_000;

// base58, 64-byte signatures encode to 86-88 characters.
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

// One shared HTTP server carries both the admin REST API (Express)
// and the game WebSocket server, so Render only needs to expose a
// single port for the whole backend.
const app = express();
app.use(cors());
app.use(express.json());
app.use('/admin', adminRouter);

// Public, unauthenticated — just a live price quote for display. The
// client hits this instead of calling Pyth's Hermes API directly,
// since that's a browser-side CORS problem, not a security one; the
// actual payment verification already calls Pyth server-side
// regardless of what this endpoint returns.
//
// Cached for a few seconds so a flood of requests can't be turned into
// a flood of upstream Pyth calls.
let priceCache: { price: number; at: number } | null = null;
app.get('/sol-price', async (_req, res) => {
  if (priceCache && Date.now() - priceCache.at < 10_000) {
    res.json({ price: priceCache.price });
    return;
  }
  try {
    const price = await getSolUsdPrice();
    priceCache = { price, at: Date.now() };
    res.json({ price });
  } catch (err) {
    console.error('GET /sol-price failed:', err);
    res.status(502).json({ error: 'Could not fetch live SOL price right now.' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD_BYTES });

const connections = new Map<string, WebSocket>();
const playerNames = new Map<string, string>();
// Connection id -> verified Supabase account id, for signed-in players
// only. Guests never get an entry, so they never reach the leaderboard.
const userIds = new Map<string, string>();
// Players with an entry-fee verification currently in flight. Each
// verification costs RPC credits, so one at a time per player.
const verifying = new Set<string>();
const connectionsPerIp = new Map<string, number>();
const alive = new WeakMap<WebSocket, boolean>();

function send(ws: WebSocket, message: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}
function broadcastToRoom(roomCode: string, message: object, excludePlayerId?: string) {
  connections.forEach((ws, playerId) => {
    const room = getPlayerRoom(playerId);
    if (room && room.code === roomCode && playerId !== excludePlayerId) {
      send(ws, message);
    }
  });
}

// The left-most X-Forwarded-For entry is whatever the client chose to send,
// so it can't be trusted. Behind N trusted proxies (Render = 1) the real
// client address is the N-th entry from the RIGHT. With no proxy
// configured, use the socket address.
const TRUST_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUST_PROXY_HOPS || '0', 10) || 0);
function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY_HOPS > 0) {
    const fwd = req.headers['x-forwarded-for'];
    const parts = (Array.isArray(fwd) ? fwd.join(',') : fwd || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);
    const picked = parts[parts.length - TRUST_PROXY_HOPS];
    if (picked) return picked;
  }
  return req.socket.remoteAddress || 'unknown';
}

// ── Input validation ───────────────────────────────────────────────
function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
  return name.length > 0 ? name : null;
}

// Returns the canonical address if raw is a real Solana public key, else null.
function cleanWallet(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 32 || raw.length > 44) return null;
  try {
    return new PublicKey(raw).toBase58() === raw ? raw : null;
  } catch {
    return null;
  }
}

function looksUncertain(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not confirmed|timeout|timed out|expired|block height exceeded/i.test(msg);
}

// Payout handlers take the Room OBJECT captured at the moment of the
// win, not a lookup by player id afterwards. The old lookup silently
// skipped the payout whenever the winner's connection dropped between
// the winning ball and the transfer starting — exactly what happens on
// mobile. The wallet and amount are read synchronously, before any await.
async function handleWinnerPayout(room: Room, winnerId: string) {
  const roomCode = room.code;
  // Free practice games never pay anything.
  if (isPracticeRoom(roomCode)) return;
  const winner = room.players.get(winnerId);
  const wallet = winner?.walletAddress;
  if (!winner || !wallet) {
    console.error('[payout] winner has no wallet, room ' + roomCode + ', player ' + winnerId);
    broadcastToRoom(roomCode, {
      type: 'payout_error',
      message: 'Winner has no connected wallet — payout could not be sent.',
    });
    return;
  }

  const totalPrize = Math.floor(getPayoutAmount(room, winnerId) * 100) / 100;
  if (!(totalPrize > 0)) {
    console.error('[payout] computed prize is 0, room ' + roomCode);
    return;
  }

  // Read before any await — the connection (and its entry) may be gone by then.
  const winnerUserId = userIds.get(winnerId);

  const recordId = await startPayoutRecord('prize', roomCode, wallet, totalPrize);
  try {
    const txSignature = await payWinner(wallet, totalPrize);
    await finishPayoutRecord(recordId, 'sent', txSignature);
    if (winnerUserId) void recordGameResult(winnerUserId, 0, 0, totalPrize);
    broadcastToRoom(roomCode, { type: 'payout_sent', winnerId, txSignature, amount: totalPrize });
  } catch (err) {
    console.error('payWinner failed:', err);
    const unsure = looksUncertain(err);
    await finishPayoutRecord(recordId, unsure ? 'unconfirmed' : 'failed', null, err instanceof Error ? err.message : String(err));
    broadcastToRoom(roomCode, {
      type: 'payout_error',
      message: 'Payout failed. Support may need to send the prize manually.',
    });
  }
}

// Fires after a 'jackpot_won' message — completely separate transfer
// from the normal prize, sent in addition to it, never instead of it.
async function handleJackpotPayout(room: Room, winnerId: string, amount: number) {
  const roomCode = room.code;
  if (isPracticeRoom(roomCode)) return;
  const winner = room.players.get(winnerId);
  const wallet = winner?.walletAddress;
  if (!winner || !wallet) {
    console.error('[JACKPOT] winner has no wallet, room ' + roomCode + ', player ' + winnerId);
    broadcastToRoom(roomCode, {
      type: 'jackpot_payout_error',
      message: 'Jackpot winner has no connected wallet — jackpot could not be sent.',
    });
    return;
  }

  const winnerUserId = userIds.get(winnerId);

  const recordId = await startPayoutRecord('jackpot', roomCode, wallet, amount);
  try {
    const txSignature = await payJackpot(wallet, amount);
    await finishPayoutRecord(recordId, 'sent', txSignature);
    if (winnerUserId) void recordGameResult(winnerUserId, 0, 0, amount);
    broadcastToRoom(roomCode, { type: 'jackpot_paid', winnerId, txSignature, amount });
  } catch (err) {
    console.error('payJackpot failed:', err);
    const unsure = looksUncertain(err);
    await finishPayoutRecord(recordId, unsure ? 'unconfirmed' : 'failed', null, err instanceof Error ? err.message : String(err));
    broadcastToRoom(roomCode, {
      type: 'jackpot_payout_error',
      message: 'Jackpot payout failed. Support may need to send it manually.',
    });
  }
}

// Verify on-chain, then burn the signature (one use only), then credit
// the player. Order matters: verify first so a payment that simply
// isn't confirmed yet can be retried; claim second so the same
// transaction can never be credited twice.
async function processEntryFee(
  ws: WebSocket,
  playerId: string,
  walletAddress: string,
  room: Room,
  txSignature: string,
  bundleId: string,
  currency: 'OREN' | 'SOL'
) {
  const bundle = room.bundles.find(b => b.id === bundleId);
  if (!bundle) {
    send(ws, { type: 'entry_fee_rejected', message: 'Unknown bundle selected.' });
    return;
  }

  let result: { ok: boolean; reason?: string };
  if (currency === 'OREN') {
    result = await verifyEntryFeePayment(txSignature, walletAddress, orenEquivalent(room, bundle));
  } else {
    // SOL: the amount owed depends on a live price that can move
    // slightly between when the player was quoted a figure and now,
    // so re-fetch the live price at verification time and allow a
    // small tolerance rather than demanding an exact match.
    const expectedUsdt = usdtEquivalent(room, bundle);
    const solUsdPrice = await getSolUsdPrice();
    const expectedSol = expectedUsdt / solUsdPrice;
    const TOLERANCE = 0.02; // allow the payment to be up to 2% short, covers brief price drift
    const expectedLamports = Math.round(expectedSol * (1 - TOLERANCE) * 1e9);
    result = await verifySolEntryFeePayment(txSignature, walletAddress, expectedLamports);
  }

  if (!result.ok) {
    send(ws, { type: 'entry_fee_rejected', message: result.reason || 'Could not verify that payment on-chain.' });
    return;
  }

  const claim = await claimSignature(txSignature, walletAddress, room.code);
  if (claim === 'duplicate') {
    send(ws, { type: 'entry_fee_rejected', message: 'This payment has already been used for an entry.' });
    return;
  }
  if (claim === 'error') {
    send(ws, { type: 'entry_fee_rejected', message: 'Could not record your payment right now — try again in a moment.' });
    return;
  }

  const { room: updatedRoom, messages } = markEntryFeePaid(playerId, bundle.id, currency, room.code, walletAddress);
  if (updatedRoom) {
    messages.forEach(msg => broadcastToRoom(updatedRoom.code, msg));
  } else {
    // Verified and recorded, but the player can no longer be credited
    // (left the room, or the game started meanwhile). Log it so it can
    // be refunded by hand.
    console.error('[entry-fee] verified but NOT credited — refund may be needed. sig=' + txSignature + ' wallet=' + walletAddress + ' room=' + room.code);
    messages.forEach(msg => send(ws, msg));
  }
}

// Auto-removal from the wallet-connect timeout fires on its own timer,
// not as a direct response to a client message, so it comes through
// as an event instead of an inline return value.
roomEvents.on('player_removed', ({ roomCode, playerId, messages, reason }) => {
  messages.forEach((msg: object) => broadcastToRoom(roomCode, msg));
  const ws = connections.get(playerId);
  if (ws) {
    send(ws, { type: 'removed_from_room', reason });
    ws.close();
  }
  connections.delete(playerId);
  playerNames.delete(playerId);
  console.log('Player ' + playerId + ' auto-removed from ' + roomCode + ' (' + reason + ')');
});

// Drop connections that stopped answering pings (silent mobile drops),
// so ghost players don't linger in rooms.
const heartbeat = setInterval(() => {
  wss.clients.forEach(client => {
    if (alive.get(client) === false) {
      client.terminate();
      return;
    }
    alive.set(client, false);
    client.ping();
  });
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
  // Without an 'error' listener, any protocol error from a client
  // (oversized message, malformed frame) is an unhandled event that
  // CRASHES the whole server — one bad connection taking down every
  // game. Log it and let the 'close' handler below clean up.
  ws.on('error', (err: Error) => {
    console.warn('WebSocket error: ' + err.message);
  });

  const ip = clientIp(req);
  const open = connectionsPerIp.get(ip) ?? 0;
  if (open >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, 'Too many connections');
    return;
  }
  connectionsPerIp.set(ip, open + 1);

  const playerId = uuidv4();
  connections.set(playerId, ws);
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  console.log('Player connected: ' + playerId);

  // One-time challenge for this connection. A wallet is only accepted once
  // it has signed this message, which proves the player controls it.
  const challengeNonce = randomBytes(16).toString('hex');
  const walletChallenge = challengeMessage(challengeNonce);
  send(ws, { type: 'wallet_challenge', message: walletChallenge });

  let windowStart = Date.now();
  let windowCount = 0;
  let identifyAttempts = 0;
  // While a login token is being checked, game-defining messages wait for
  // the answer, so "signed in or guest" is always settled before a room
  // is created or started.
  let pendingIdentify: Promise<void> | null = null;

  // Leave any room this connection is already in before it creates or
  // joins another, so it can never sit in two rooms at once.
  function leaveCurrentRoom() {
    const { roomCode, messages } = leaveRoom(playerId);
    if (roomCode) messages.forEach(msg => broadcastToRoom(roomCode, msg));
  }

  ws.on('message', (data: Buffer) => {
    const now = Date.now();
    if (now - windowStart > RATE_WINDOW_MS) {
      windowStart = now;
      windowCount = 0;
    }
    if (++windowCount > RATE_MAX_MESSAGES) {
      console.warn('Rate limit hit, closing ' + playerId + ' (' + ip + ')');
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!parsed || typeof parsed !== 'object') {
        send(ws, { type: 'error', message: 'Invalid message format' });
        return;
      }
      // The browser sends its Supabase login token once, right after
      // connecting. The token is checked with Supabase itself, so it can't
      // be faked. A few attempts per connection, no more.
      if ((parsed as { type?: unknown }).type === 'identify') {
        const token = (parsed as { accessToken?: unknown }).accessToken;
        if (identifyAttempts < 3 && typeof token === 'string' && token.length >= 20 && token.length <= 4096) {
          identifyAttempts++;
          const p: Promise<void> = userIdFromToken(token)
            .then(uid => {
              if (uid) userIds.set(playerId, uid);
            })
            .catch(() => { /* treated as a guest */ })
            .then(() => {
              if (pendingIdentify === p) pendingIdentify = null;
            });
          pendingIdentify = p;
        }
        return;
      }
      {
        const t = (parsed as { type?: unknown }).type;
        if (pendingIdentify && (t === 'create_room' || t === 'join_room' || t === 'start_game')) {
          void pendingIdentify.then(() => ws.emit('message', data));
          return;
        }
      }

      const message = parsed as ClientMessage;
      switch (message.type) {
        case 'create_room': {
          const name = cleanName(message.playerName);
          if (!name) {
            send(ws, { type: 'error', message: 'Please enter a valid name (1-20 characters).' });
            return;
          }
          if (verifying.has(playerId)) {
            send(ws, { type: 'error', message: 'Your payment is being verified — one moment.' });
            return;
          }
          leaveCurrentRoom();
          playerNames.set(playerId, name);
          const { room, messages } = createRoom(
            playerId,
            name,
            // Wallets are attached later through set_wallet, with proof.
            null,
            typeof message.maxPlayers === 'number' ? message.maxPlayers : undefined,
            message.isSolo === true
          );
          // A solo game started by someone who is not signed in is a free
          // practice game: nothing is paid in and nothing can be won.
          if (room.isSolo && !userIds.has(playerId)) {
            markPracticeRoom(room);
            console.log('Practice (guest) room created: ' + room.code);
            messages.forEach(msg => {
              if (msg.type === 'room_created') {
                Object.assign(msg, { practice: true, jackpotEnabled: false, jackpotAmountOren: 0 });
              }
            });
          }
          messages.forEach(msg => {
            if (msg.type === 'cards_dealt') {
              send(ws, msg);
            } else {
              send(ws, msg);
              broadcastToRoom(room.code, msg, playerId);
            }
          });
          console.log('Room created: ' + room.code + ' by ' + name);
          break;
        }
        case 'join_room': {
          const name = cleanName(message.playerName);
          if (!name || typeof message.roomCode !== 'string' || message.roomCode.length > 12) {
            send(ws, { type: 'error', message: 'Please enter a valid name and room code.' });
            return;
          }
          if (verifying.has(playerId)) {
            send(ws, { type: 'error', message: 'Your payment is being verified — one moment.' });
            return;
          }
          leaveCurrentRoom();
          playerNames.set(playerId, name);
          const { room, messages } = joinRoom(
            message.roomCode.toUpperCase(),
            playerId,
            name,
            null
          );
          if (room) {
            messages.forEach(msg => {
              // room_created carries the JOINER's own playerId, so only the
              // joiner may receive it — everyone else would adopt it as theirs.
              if (msg.type === 'cards_dealt' || msg.type === 'room_created') {
                send(ws, msg);
              } else {
                broadcastToRoom(room.code, msg);
              }
            });
            console.log(name + ' joined room ' + room.code);
          } else {
            messages.forEach(msg => send(ws, msg));
          }
          break;
        }
        case 'set_wallet': {
          const wallet = cleanWallet(message.walletAddress);
          if (!wallet) {
            send(ws, { type: 'error', message: 'That does not look like a valid Solana wallet address.' });
            return;
          }
          if (verifying.has(playerId)) {
            send(ws, { type: 'error', message: 'Your payment is being verified — one moment.' });
            return;
          }
          const walletSignature = (message as { walletSignature?: unknown }).walletSignature;
          // The second check covers Farcaster's wallet, which signs our
          // challenge text as if it were base64 (see farcasterProof.ts).
          if (
            !verifyWalletSignature(wallet, walletChallenge, walletSignature) &&
            !verifyFarcasterBase64Quirk(wallet, walletChallenge, walletSignature)
          ) {
            send(ws, { type: 'error', message: 'Could not verify that you own this wallet. Approve the signature request in your wallet and try again.' });
            return;
          }
          const { room, messages, rejected } = setWallet(playerId, wallet);
          if (rejected) {
            send(ws, { type: 'error', message: rejected });
            return;
          }
          if (room) {
            messages.forEach(msg => broadcastToRoom(room.code, msg));
          }
          break;
        }
        case 'submit_entry_fee': {
          const room = getPlayerRoom(playerId);
          if (!room) {
            send(ws, { type: 'error', message: 'Not in a room' });
            return;
          }
          if (isPracticeRoom(room.code)) {
            send(ws, { type: 'entry_fee_rejected', message: 'This is a free practice game. Sign in to play for OREN.' });
            return;
          }
          const player = room.players.get(playerId);
          if (!player?.walletAddress) {
            send(ws, { type: 'entry_fee_rejected', message: 'Connect a wallet before paying the entry fee' });
            return;
          }
          if (room.phase !== 'waiting') {
            send(ws, { type: 'entry_fee_rejected', message: 'This game has already started.' });
            return;
          }
          if (player.paidEntryFee) {
            send(ws, { type: 'entry_fee_rejected', message: 'You have already paid for this game.' });
            return;
          }
          if (verifying.has(playerId)) {
            send(ws, { type: 'entry_fee_rejected', message: 'Your payment is already being verified — one moment.' });
            return;
          }
          if (typeof message.txSignature !== 'string' || !SIGNATURE_RE.test(message.txSignature)) {
            send(ws, { type: 'entry_fee_rejected', message: 'Invalid transaction signature.' });
            return;
          }
          if (typeof message.bundleId !== 'string') {
            send(ws, { type: 'entry_fee_rejected', message: 'Unknown bundle selected.' });
            return;
          }

          // Verify against THIS room's own bundle snapshot, not the
          // current global config — a room keeps whatever prices were
          // in effect when it was created, even if an admin changes
          // pricing afterward.
          const currency = message.currency === 'SOL' ? 'SOL' : 'OREN';
          verifying.add(playerId);
          processEntryFee(ws, playerId, player.walletAddress, room, message.txSignature, message.bundleId, currency)
            .catch(err => {
              console.error('processEntryFee failed:', err);
              send(ws, { type: 'entry_fee_rejected', message: 'Could not verify payment right now — try again in a moment.' });
            })
            .finally(() => verifying.delete(playerId));
          break;
        }
        case 'remove_player': {
          if (typeof message.playerId !== 'string') {
            send(ws, { type: 'error', message: 'Invalid message format' });
            return;
          }
          const { roomCode, messages } = removePlayer(playerId, message.playerId);
          if (roomCode) {
            messages.forEach(msg => broadcastToRoom(roomCode, msg));
            const targetWs = connections.get(message.playerId);
            if (targetWs) {
              send(targetWs, { type: 'removed_from_room', reason: 'host_removed' });
              targetWs.close();
            }
            connections.delete(message.playerId);
            playerNames.delete(message.playerId);
          } else {
            messages.forEach(msg => send(ws, msg));
          }
          break;
        }
        case 'start_game': {
          const room = getPlayerRoom(playerId);
          if (!room) {
            send(ws, { type: 'error', message: 'Not in a room' });
            return;
          }
          const { room: startedRoom, messages } = startGame(room.code, playerId);
          if (!startedRoom) {
            messages.forEach(msg => send(ws, msg));
            return;
          }
          startedRoom.players.forEach((player, pid) => {
            const playerWs = connections.get(pid);
            if (playerWs) {
              send(playerWs, { type: 'cards_dealt', cards: player.cards });
            }
          });
          broadcastToRoom(startedRoom.code, { type: 'game_starting', countdown: 3 });
          let drawInterval: NodeJS.Timeout;
          setTimeout(() => {
            drawInterval = setInterval(() => {
              const result = drawBall(startedRoom.code);
              if (!result.room) {
                clearInterval(drawInterval);
                return;
              }
              result.messages.forEach(msg => {
                broadcastToRoom(startedRoom.code, msg);
                if (msg.type === 'bingo') {
                  handleWinnerPayout(startedRoom, msg.winnerId);
                }
                // jackpot_won is pushed right alongside 'bingo' by
                // drawBall when the slim random chance hits — this is
                // a SEPARATE transfer from the normal prize above,
                // never a replacement for it.
                if (msg.type === 'jackpot_won') {
                  handleJackpotPayout(startedRoom, msg.winnerId, msg.amount);
                }
                // Game finished normally: every signed-in player who
                // took part gets a game played, and the winner a win.
                // (Winnings are added separately, once the prize
                // transfer actually succeeds.)
                if (msg.type === 'game_over') {
                  startedRoom.players.forEach((_p, pid) => {
                    const uid = userIds.get(pid);
                    if (uid) void recordGameResult(uid, 1, pid === msg.winnerId ? 1 : 0, 0);
                  });
                }
              });
              if (result.room.phase === 'finished') {
                clearInterval(drawInterval);
              }
            }, 3000);
          }, 3000);
          console.log('Game started in room ' + startedRoom.code);
          break;
        }
        case 'leave_room': {
          const { roomCode, messages } = leaveRoom(playerId);
          if (roomCode) {
            messages.forEach(msg => broadcastToRoom(roomCode, msg));
          }
          connections.delete(playerId);
          playerNames.delete(playerId);
          console.log('Player left: ' + playerId);
          break;
        }
      }
    } catch (err) {
      console.error('Error handling message:', err);
      send(ws, { type: 'error', message: 'Invalid message format' });
    }
  });
  ws.on('close', () => {
    const left = connectionsPerIp.get(ip) ?? 1;
    if (left <= 1) connectionsPerIp.delete(ip);
    else connectionsPerIp.set(ip, left - 1);

    const { roomCode, messages } = leaveRoom(playerId);
    if (roomCode) {
      messages.forEach(msg => broadcastToRoom(roomCode, msg));
    }
    connections.delete(playerId);
    playerNames.delete(playerId);
    userIds.delete(playerId);
    verifying.delete(playerId);
    console.log('Player disconnected: ' + playerId);
  });
});

// Load the admin-editable config before accepting any connections, so
// the very first room created uses real settings, not defaults.
loadConfigFromDb()
  .catch((err: unknown) => console.error('Failed to load game config, using defaults:', err))
  .finally(() => {
    server.listen(PORT, () => {
      console.log('NoxBingo server running on port ' + PORT);
      console.log('Features: practice-games, wallet-proof');
      console.log('Treasury pubkey: ' + TREASURY_PUBLIC_KEY);
    });
  });