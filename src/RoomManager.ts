import { EventEmitter } from 'events';
import { randomBytes, randomInt } from 'crypto';
import { Room, Player, ServerMessage, CardBundle } from './types';
import { generateCards, generateDrawSequence, checkForWin, autoDaub, getLetterForNumber } from './GameEngine';
import { getConfig } from './gameConfig';

function getBundle(room: Room, bundleId: string): CardBundle | undefined {
  return room.bundles.find(b => b.id === bundleId);
}

// The OREN-equivalent value of a bundle's stake, given this room's
// snapshot rate. Used for BOTH currencies — an OREN payer's actual
// OREN amount owed, and the figure recorded as "stake value" for a
// SOL payer too, so pot/payout math never has to care which currency
// someone actually paid in.
export function orenEquivalent(room: Room, bundle: CardBundle): number {
  return bundle.priceGBP / room.orenToGbpRate;
}

// The USDT-equivalent value of a bundle's stake — the bridge currency
// on the way to computing an actual SOL amount (divide this by the
// live SOL/USD price from Pyth).
export function usdtEquivalent(room: Room, bundle: CardBundle): number {
  return bundle.priceGBP * room.gbpToUsdtRate;
}

const DEFAULT_SOLO_MULTIPLIER = 3.5;

// A player has this long to both connect a wallet AND have a bundle
// payment verified before being auto-removed from a still-waiting room.
const READY_TIMEOUT_MS = 90 * 1000;

const rooms = new Map<string, Room>();
const playerRooms = new Map<string, string>();
const roomTimers = new Map<string, NodeJS.Timeout>();
const readyTimers = new Map<string, NodeJS.Timeout>();

// Free practice games: a solo room created by someone who is NOT signed
// in. No wallet, no payment, no prizes, no jackpot, no leaderboard stats.
// Decided by the server (never by a client flag), so a guest can never
// turn a free game into a paid prize.
const practiceRooms = new Set<string>();
export function isPracticeRoom(roomCode: string): boolean {
  return practiceRooms.has(roomCode);
}
export function markPracticeRoom(room: Room): void {
  if (!room.isSolo) return;
  practiceRooms.add(room.code);
  room.jackpotEnabled = false;
  room.jackpotAmountOren = 0;
  room.players.forEach((_p, pid) => clearReadyTimer(pid));
}

export const roomEvents = new EventEmitter();

// ── Reconnection ───────────────────────────────────────────────────
// Phones cut a page's connection when the player switches apps (e.g. to
// Phantom to approve a payment). Instead of removing the player straight
// away, their seat is held so they can pick up where they left off.
//
// How long a dropped player's seat is held before a WAITING room lets it
// go. Once a game has started the seat is never released mid-game: their
// cards keep being marked automatically and they can still win and be paid.
const RECONNECT_GRACE_MS = 60 * 1000;
// Finished rooms are kept this long so late reconnecters can see the result.
const FINISHED_ROOM_TTL_MS = 15 * 60 * 1000;

// Secret per-seat token, sent only to that player, that lets a new
// connection take the seat back.
const resumeTokens = new Map<string, { roomCode: string; playerId: string }>();
const playerResumeTokens = new Map<string, string>();
const graceTimers = new Map<string, NodeJS.Timeout>();
const finishedRoomTimers = new Map<string, NodeJS.Timeout>();

function issueResumeToken(playerId: string, roomCode: string): string {
  revokeResumeToken(playerId);
  const token = randomBytes(32).toString('hex');
  resumeTokens.set(token, { roomCode, playerId });
  playerResumeTokens.set(playerId, token);
  return token;
}

function revokeResumeToken(playerId: string) {
  const token = playerResumeTokens.get(playerId);
  if (token) resumeTokens.delete(token);
  playerResumeTokens.delete(playerId);
}

function clearGraceTimer(playerId: string) {
  const timer = graceTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    graceTimers.delete(playerId);
  }
}

export function getResumeToken(playerId: string): string | null {
  return playerResumeTokens.get(playerId) ?? null;
}

/** Removes a whole room and everything tied to its players. */
function closeRoom(room: Room) {
  const playerIds = Array.from(room.players.keys());
  for (const pid of playerIds) {
    if (playerRooms.get(pid) === room.code) playerRooms.delete(pid);
    revokeResumeToken(pid);
    clearReadyTimer(pid);
    clearGraceTimer(pid);
  }
  rooms.delete(room.code);
  practiceRooms.delete(room.code);
  clearRoomTimer(room.code);
  const finishedTimer = finishedRoomTimers.get(room.code);
  if (finishedTimer) clearTimeout(finishedTimer);
  finishedRoomTimers.delete(room.code);
  roomEvents.emit('room_closed', { roomCode: room.code, playerIds });
}

function scheduleFinishedRoomCleanup(roomCode: string) {
  if (finishedRoomTimers.has(roomCode)) return;
  const timer = setTimeout(() => {
    finishedRoomTimers.delete(roomCode);
    const room = rooms.get(roomCode);
    if (room) closeRoom(room);
  }, FINISHED_ROOM_TTL_MS);
  finishedRoomTimers.set(roomCode, timer);
}

/**
 * Called when a player's connection drops. Holds their seat instead of
 * removing them. Returns a players_update for the room so others can
 * see the player is reconnecting.
 */
export function markDisconnected(playerId: string): { roomCode: string | null; messages: ServerMessage[] } {
  const room = getPlayerRoom(playerId);
  if (!room) return { roomCode: null, messages: [] };
  const player = room.players.get(playerId);
  if (!player) return { roomCode: null, messages: [] };

  player.connected = false;
  clearGraceTimer(playerId);
  const roomCode = room.code;
  const timer = setTimeout(() => {
    graceTimers.delete(playerId);
    const current = rooms.get(roomCode);
    const p = current?.players.get(playerId);
    if (!current || !p || p.connected) return;
    // Only a room that hasn't started lets the seat go. Mid-game the
    // player stays in: their cards are marked automatically and they can
    // still win. Finished rooms are cleaned up on their own timer.
    if (current.phase === 'waiting') {
      const messages = removePlayerFromRoom(current, playerId);
      if (messages) {
        roomEvents.emit('player_removed', { roomCode, playerId, messages, reason: 'disconnected' });
      }
    }
  }, RECONNECT_GRACE_MS);
  graceTimers.set(playerId, timer);

  return { roomCode, messages: [playersUpdateMessage(room, room.hostId)] };
}

/**
 * Lets a new connection take back a held seat. Returns the seat's
 * original player id, which the connection must use from now on.
 */
export function resumePlayer(
  token: string
): { room: Room; playerId: string; messages: ServerMessage[] } | { error: 'expired' } {
  const entry = resumeTokens.get(token);
  if (!entry) return { error: 'expired' };
  const room = rooms.get(entry.roomCode);
  const player = room?.players.get(entry.playerId);
  if (!room || !player || playerRooms.get(entry.playerId) !== room.code) {
    resumeTokens.delete(token);
    return { error: 'expired' };
  }
  clearGraceTimer(entry.playerId);
  player.connected = true;
  return { room, playerId: entry.playerId, messages: [playersUpdateMessage(room, room.hostId)] };
}

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[randomInt(chars.length)];
  }
  if (rooms.has(code)) return generateRoomCode();
  return code;
}
function getPlayerList(room: Room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    walletAddress: p.walletAddress,
    paidEntryFee: p.paidEntryFee,
    bundleId: p.bundleId,
    cardCount: p.cardCount,
    // false while the player's connection has dropped and their seat is held
    connected: p.connected !== false,
  }));
}
function playersUpdateMessage(room: Room, hostId: string | null): ServerMessage {
  return { type: 'players_update', players: getPlayerList(room), hostId, maxPlayers: room.maxPlayers };
}
function isReady(player: Player, room?: Room): boolean {
  if (room && practiceRooms.has(room.code)) return true;
  return !!player.walletAddress && player.paidEntryFee;
}

function clearRoomTimer(roomCode: string) {
  const timer = roomTimers.get(roomCode);
  if (timer) {
    clearTimeout(timer);
    roomTimers.delete(roomCode);
  }
}

function clearReadyTimer(playerId: string) {
  const timer = readyTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    readyTimers.delete(playerId);
  }
}

function scheduleReadyTimeout(playerId: string, roomCode: string) {
  clearReadyTimer(playerId);
  const timer = setTimeout(() => {
    readyTimers.delete(playerId);
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player || isReady(player, room) || room.phase !== 'waiting') return;
    const reason = !player.walletAddress ? 'wallet_timeout' : 'fee_timeout';
    const messages = removePlayerFromRoom(room, playerId);
    if (messages) {
      roomEvents.emit('player_removed', { roomCode, playerId, messages, reason });
    }
  }, READY_TIMEOUT_MS);
  readyTimers.set(playerId, timer);
}

function removePlayerFromRoom(room: Room, playerId: string): ServerMessage[] | null {
  const player = room.players.get(playerId);
  if (!player) return null;
  const wasHost = room.hostId === playerId;
  room.players.delete(playerId);
  playerRooms.delete(playerId);
  clearReadyTimer(playerId);
  clearGraceTimer(playerId);
  revokeResumeToken(playerId);

  // A paid seat that disappears before the game starts: the stake is
  // already on-chain and the entry signature is burned, so leave a record
  // that a refund may be due.
  if (player.paidEntryFee && room.phase === 'waiting' && !practiceRooms.has(room.code)) {
    console.warn('[refund] paid seat removed before start. room=' + room.code + ' wallet=' + player.walletAddress + ' amountOren=' + player.amountPaidOren);
  }

  const messages: ServerMessage[] = [
    { type: 'player_left', playerId, playerName: player.name, playerCount: room.players.size },
    playersUpdateMessage(room, wasHost ? (room.players.size > 0 ? Array.from(room.players.keys())[0] : null) : room.hostId),
  ];
  // If the host drops mid-game the game carries on: the draw loop does not
  // depend on the host, and ending it would void everyone's paid entry.
  if (room.players.size === 0) {
    closeRoom(room);
  } else if (wasHost) {
    room.hostId = Array.from(room.players.keys())[0];
  }
  return messages;
}

export function createRoom(
  playerId: string,
  playerName: string,
  walletAddress: string | null = null,
  maxPlayers: number = 6,
  isSolo: boolean = false
): { room: Room; messages: ServerMessage[] } {
  const code = generateRoomCode();
  // Clamp to a sane range server-side — never trust a client-supplied
  // number directly, even for something this low-stakes. Solo rooms
  // are always exactly 1 player, regardless of what was requested.
  const clampedMax = isSolo ? 1 : Math.max(1, Math.min(10, Math.floor(maxPlayers) || 6));
  const player: Player = {
    id: playerId,
    name: playerName,
    cards: [],
    connected: true,
    walletAddress,
    paidEntryFee: false,
    bundleId: null,
    cardCount: 0,
    amountPaidOren: 0,
    paymentCurrency: null,
  };
  const players = new Map<string, Player>();
  players.set(playerId, player);

  const config = getConfig();
  const room: Room = {
    code,
    hostId: playerId,
    maxPlayers: clampedMax,
    isSolo,
    ballCap: config.ballCap,
    rakePercent: config.rakePercent,
    bundles: config.bundles,
    soloMultipliers: config.soloMultipliers,
    noxBonusDisplay: config.noxBonusDisplay,
    orenToGbpRate: config.orenToGbpRate,
    gbpToUsdtRate: config.gbpToUsdtRate,
    jackpotEnabled: config.jackpotEnabled,
    jackpotAmountOren: config.jackpotAmountOren,
    jackpotOddsOneIn: config.jackpotOddsOneIn,
    players,
    drawSequence: [],
    currentDrawIndex: -1,
    phase: 'waiting',
    winningPlayerId: null,
    bonusWinnerId: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  playerRooms.set(playerId, code);
  const timer = setTimeout(() => {
    const existingRoom = rooms.get(code);
    if (existingRoom && existingRoom.phase === 'waiting' && existingRoom.players.size <= 1) {
      closeRoom(existingRoom);
      console.log('Room expired: ' + code);
    }
  }, 3 * 60 * 1000);
  roomTimers.set(code, timer);
  scheduleReadyTimeout(playerId, code);
  issueResumeToken(playerId, code);
  return {
    room,
    messages: [
      {
        type: 'room_created',
        roomCode: code,
        playerId,
        hostId: playerId,
        maxPlayers: clampedMax,
        noxBonusDisplay: room.noxBonusDisplay,
        orenToGbpRate: room.orenToGbpRate,
        gbpToUsdtRate: room.gbpToUsdtRate,
        bundles: room.bundles,
        jackpotEnabled: room.jackpotEnabled,
        jackpotAmountOren: room.jackpotAmountOren,
      },
      { type: 'players_update', players: getPlayerList(room), hostId: playerId, maxPlayers: clampedMax },
    ],
  };
}
export function joinRoom(
  roomCode: string,
  playerId: string,
  playerName: string,
  walletAddress: string | null = null
): { room: Room; messages: ServerMessage[] } {
  const room = rooms.get(roomCode);
  if (!room) {
    return { room: null as any, messages: [{ type: 'error', message: 'Room not found or expired' }] };
  }
  if (room.phase !== 'waiting') {
    return { room: null as any, messages: [{ type: 'error', message: 'Game already in progress' }] };
  }
  if (room.players.size >= room.maxPlayers) {
    return { room: null as any, messages: [{ type: 'error', message: `Room is full (max ${room.maxPlayers} players)` }] };
  }
  const player: Player = {
    id: playerId,
    name: playerName,
    cards: [],
    connected: true,
    walletAddress,
    paidEntryFee: false,
    bundleId: null,
    cardCount: 0,
    amountPaidOren: 0,
    paymentCurrency: null,
  };
  room.players.set(playerId, player);
  playerRooms.set(playerId, roomCode);
  clearRoomTimer(roomCode);
  scheduleReadyTimeout(playerId, roomCode);
  issueResumeToken(playerId, roomCode);
  const messages: ServerMessage[] = [
    { type: 'player_joined', playerId, playerName, playerCount: room.players.size },
    playersUpdateMessage(room, room.hostId),
    {
      type: 'room_created',
      roomCode: room.code,
      playerId,
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      noxBonusDisplay: room.noxBonusDisplay,
      orenToGbpRate: room.orenToGbpRate,
      gbpToUsdtRate: room.gbpToUsdtRate,
      bundles: room.bundles,
      jackpotEnabled: room.jackpotEnabled,
      jackpotAmountOren: room.jackpotAmountOren,
    },
  ];
  return { room, messages };
}

// `rejected` is set when the change was refused — the caller should
// tell only the requesting player, not broadcast it to the room.
export function setWallet(
  playerId: string,
  walletAddress: string
): { room: Room | null; messages: ServerMessage[]; rejected?: string } {
  const room = getPlayerRoom(playerId);
  if (!room) return { room: null, messages: [] };
  const player = room.players.get(playerId);
  if (!player) return { room: null, messages: [] };

  // Once a player has paid (or the game has begun), the wallet that
  // paid is the wallet that gets paid out. Letting it change after
  // that would let someone verify a payment as one wallet and then
  // redirect the prize to another.
  if (
    player.walletAddress &&
    player.walletAddress !== walletAddress &&
    (player.paidEntryFee || room.phase !== 'waiting')
  ) {
    return {
      room: null,
      messages: [],
      rejected: 'Your wallet is locked once you have paid. Reconnect the wallet you paid with.',
    };
  }

  player.walletAddress = walletAddress;
  if (isReady(player)) clearReadyTimer(playerId);
  return { room, messages: [playersUpdateMessage(room, room.hostId)] };
}

export function markEntryFeePaid(
  playerId: string,
  bundleId: string,
  currency: 'OREN' | 'SOL',
  // The seat the payment was verified for. If the player has moved to a
  // different room or wallet since, the payment is NOT credited here.
  verifiedRoomCode: string,
  verifiedWallet: string
): { room: Room | null; messages: ServerMessage[] } {
  const room = getPlayerRoom(playerId);
  if (!room) return { room: null, messages: [] };
  const player = room.players.get(playerId);
  if (!player) return { room: null, messages: [] };
  if (room.code !== verifiedRoomCode || player.walletAddress !== verifiedWallet) {
    return { room: null, messages: [{ type: 'entry_fee_rejected', message: 'Your room or wallet changed while the payment was being verified.' }] };
  }
  if (room.phase !== 'waiting') {
    return { room: null, messages: [{ type: 'entry_fee_rejected', message: 'This game has already started.' }] };
  }
  if (player.paidEntryFee) {
    return { room: null, messages: [{ type: 'entry_fee_rejected', message: 'You have already paid for this game.' }] };
  }
  const bundle = getBundle(room, bundleId);
  if (!bundle) return { room: null, messages: [{ type: 'entry_fee_rejected', message: 'Unknown bundle.' }] };

  player.paidEntryFee = true;
  player.bundleId = bundle.id;
  player.cardCount = bundle.cardCount;
  player.amountPaidOren = orenEquivalent(room, bundle);
  player.paymentCurrency = currency;
  if (isReady(player)) clearReadyTimer(playerId);
  return {
    room,
    messages: [
      { type: 'entry_fee_confirmed', playerId, cardCount: bundle.cardCount },
      playersUpdateMessage(room, room.hostId),
    ],
  };
}

export function removePlayer(
  requesterId: string,
  targetPlayerId: string
): { roomCode: string | null; messages: ServerMessage[] } {
  const room = getPlayerRoom(requesterId);
  if (!room) return { roomCode: null, messages: [{ type: 'error', message: 'Not in a room' }] };
  if (room.hostId !== requesterId) {
    return { roomCode: null, messages: [{ type: 'error', message: 'Only the host can remove players' }] };
  }
  if (requesterId === targetPlayerId) {
    return { roomCode: null, messages: [{ type: 'error', message: 'Use leave room instead of removing yourself' }] };
  }
  // Paid players can't be kicked once the game has started: they would
  // lose their stake and their chance to win.
  if (room.phase !== 'waiting') {
    return { roomCode: null, messages: [{ type: 'error', message: 'Players cannot be removed once the game has started.' }] };
  }
  const messages = removePlayerFromRoom(room, targetPlayerId);
  if (!messages) {
    return { roomCode: null, messages: [{ type: 'error', message: 'Player not found in room' }] };
  }
  return { roomCode: room.code, messages };
}

export function leaveRoom(playerId: string): { roomCode: string | null; messages: ServerMessage[] } {
  const room = getPlayerRoom(playerId);
  if (!room) return { roomCode: null, messages: [] };
  const roomCode = room.code;
  const messages = removePlayerFromRoom(room, playerId);
  return { roomCode: messages ? roomCode : null, messages: messages || [] };
}
export function startGame(roomCode: string, playerId: string): { room: Room; messages: ServerMessage[] } {
  const room = rooms.get(roomCode);
  if (!room) {
    return { room: null as any, messages: [{ type: 'error', message: 'Room not found' }] };
  }
  if (room.hostId !== playerId) {
    return { room: null as any, messages: [{ type: 'error', message: 'Only the host can start the game' }] };
  }
  // A room plays exactly one game. Without this, a finished (or
  // running) room could be started again with everyone's old payment
  // still counted as "paid" — free replays, and a second draw loop
  // running alongside the first.
  if (room.phase !== 'waiting') {
    return { room: null as any, messages: [{ type: 'error', message: 'This game has already started or finished.' }] };
  }
  if (room.players.size < 1) {
    return { room: null as any, messages: [{ type: 'error', message: 'Need at least 1 player' }] };
  }
  const notReady = Array.from(room.players.values()).find(p => !isReady(p, room));
  if (notReady) {
    return {
      room: null as any,
      messages: [{ type: 'error', message: notReady.name + ' has not finished connecting a wallet and paying for a bundle' }],
    };
  }
  // Unpredictable seed. The old one (room code + timestamp) was
  // guessable, which would make the draw order and every card
  // computable in advance by anyone who knew the algorithm.
  // Fix the pot now: players who drop out later must not shrink it.
  room.potOren = Array.from(room.players.values()).reduce((sum, p) => sum + p.amountPaidOren, 0);
  const seed = roomCode + '-' + randomBytes(16).toString('hex');
  room.drawSequence = generateDrawSequence(seed);
  room.currentDrawIndex = -1;
  room.phase = 'playing';
  room.winningPlayerId = null;
  room.bonusWinnerId = null;
  room.players.forEach((player) => {
    // Each player gets however many cards their verified bundle paid
    // for — no longer a flat 3 for everyone.
    if (practiceRooms.has(room.code)) player.cardCount = 1;
    player.cards = generateCards(seed + '-' + player.id, player.cardCount);
    clearReadyTimer(player.id);
  });
  return { room, messages: [] };
}
export function drawBall(roomCode: string): { room: Room; messages: ServerMessage[] } {
  const room = rooms.get(roomCode);
  if (!room || room.phase !== 'playing') {
    return { room: null as any, messages: [] };
  }
  const nextIndex = room.currentDrawIndex + 1;
  if (nextIndex >= room.drawSequence.length) {
    return { room: null as any, messages: [] };
  }
  const ball = room.drawSequence[nextIndex];
  room.currentDrawIndex = nextIndex;
  const messages: ServerMessage[] = [
    { type: 'ball_drawn', ball, letter: getLetterForNumber(ball), index: nextIndex },
  ];
  let gameEnded = false;
  for (const [pid, player] of room.players.entries()) {
    if (gameEnded) break;
    player.cards = autoDaub(player.cards, ball);
    const winner = checkForWin(player.cards);
    if (winner !== null) {
      room.winningPlayerId = pid;
      room.phase = 'finished';
      gameEnded = true;
      messages.push({
        type: 'bingo',
        winnerId: pid,
        winnerName: player.name,
        cardIndex: winner,
      });

      // Jackpot is rolled exactly once per completed game, and only
      // when that game actually produced a bingo winner — never on a
      // game that times out with nobody winning. This message is just
      // the announcement; index.ts is responsible for calling
      // solana.payJackpot() and broadcasting 'jackpot_paid' once the
      // on-chain transfer actually confirms, same as it already does
      // for the normal payout via payWinner/payout_sent.
      //
      // randomInt(n) is a cryptographically secure draw in [0, n), so
      // "=== 0" is exactly a 1-in-n chance.
      const odds = Math.max(2, Math.floor(room.jackpotOddsOneIn));
      if (room.jackpotEnabled && !practiceRooms.has(room.code) && randomInt(odds) === 0) {
        messages.push({
          type: 'jackpot_won',
          winnerId: pid,
          winnerName: player.name,
          amount: room.jackpotAmountOren,
        });
      }
      break;
    }
    for (let i = 0; i < player.cards.length; i++) {
      const card = player.cards[i];
      if (card.noxCell && !card.noxHit) {
        const noxCellValue = card.grid[card.noxCell.row][card.noxCell.col];
        if (typeof noxCellValue.value === 'number' && noxCellValue.value === ball) {
          card.noxHit = true;
          if (!room.bonusWinnerId) room.bonusWinnerId = pid;
          messages.push({
            type: 'nox_bonus',
            winnerId: pid,
            winnerName: player.name,
            cardIndex: i,
          });
        }
      }
    }
  }
  if (nextIndex >= room.ballCap - 1 && !gameEnded) {
    room.phase = 'finished';
    messages.push({ type: 'game_over', winnerId: null, winnerName: null });
  } else if (gameEnded) {
    messages.push({
      type: 'game_over',
      winnerId: room.winningPlayerId,
      winnerName: room.players.get(room.winningPlayerId!)?.name || null,
    });
  }
  if (room.phase === 'finished') scheduleFinishedRoomCleanup(room.code);
  return { room, messages };
}

export function getPayoutAmount(room: Room, winnerId: string): number {
  if (practiceRooms.has(room.code)) return 0;
  if (room.isSolo) {
    const winner = room.players.get(winnerId);
    if (!winner) return 0;
    const multiplier = (winner.bundleId && room.soloMultipliers[winner.bundleId]) || DEFAULT_SOLO_MULTIPLIER;
    return winner.amountPaidOren * multiplier;
  }
  const pot = room.potOren ?? Array.from(room.players.values()).reduce((sum, p) => sum + p.amountPaidOren, 0);
  return pot * (1 - room.rakePercent);
}

export function getRoom(roomCode: string): Room | undefined {
  return rooms.get(roomCode);
}
export function getPlayerRoom(playerId: string): Room | undefined {
  const roomCode = playerRooms.get(playerId);
  if (!roomCode) return undefined;
  return rooms.get(roomCode);
}

// For the admin dashboard's live stats view.
export function getRoomStats(): { activeRooms: number; activePlayers: number } {
  let activePlayers = 0;
  for (const room of rooms.values()) activePlayers += room.players.size;
  return { activeRooms: rooms.size, activePlayers };
}
