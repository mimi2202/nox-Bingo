import { EventEmitter } from 'events';
import { Room, Player, ServerMessage, CardBundle } from './types';
import { generateCards, generateDrawSequence, checkForWin, autoDaub, getLetterForNumber } from './GameEngine';
import { getConfig } from './gameConfig';

function getBundle(room: Room, bundleId: string): CardBundle | undefined {
  return room.bundles.find(b => b.id === bundleId);
}

export function orenEquivalent(room: Room, bundle: CardBundle): number {
  return bundle.priceGBP / room.orenToGbpRate;
}

export function usdtEquivalent(room: Room, bundle: CardBundle): number {
  return bundle.priceGBP * room.gbpToUsdtRate;
}

const DEFAULT_SOLO_MULTIPLIER = 3.5;

const READY_TIMEOUT_MS = 90 * 1000;

const rooms = new Map<string, Room>();
const playerRooms = new Map<string, string>();
const roomTimers = new Map<string, NodeJS.Timeout>();
const readyTimers = new Map<string, NodeJS.Timeout>();

export const roomEvents = new EventEmitter();

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
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
  }));
}
function playersUpdateMessage(room: Room, hostId: string | null): ServerMessage {
  return { type: 'players_update', players: getPlayerList(room), hostId, maxPlayers: room.maxPlayers };
}
function isReady(player: Player): boolean {
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
    if (!player || isReady(player) || room.phase !== 'waiting') return;
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

  const gameEnded = wasHost && (room.phase === 'playing' || room.phase === 'countdown');
  const messages: ServerMessage[] = [
    { type: 'player_left', playerId, playerName: player.name, playerCount: room.players.size },
    playersUpdateMessage(room, wasHost ? (room.players.size > 0 ? Array.from(room.players.keys())[0] : null) : room.hostId),
  ];
  if (gameEnded) {
    room.phase = 'finished';
    messages.push({ type: 'game_over', winnerId: null, winnerName: null });
  }
  if (room.players.size === 0) {
    rooms.delete(room.code);
    clearRoomTimer(room.code);
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
      rooms.delete(code);
      console.log('Room expired: ' + code);
    }
  }, 3 * 60 * 1000);
  roomTimers.set(code, timer);
  scheduleReadyTimeout(playerId, code);
  return {
    room,
    messages: [
      { type: 'room_created', roomCode: code, playerId, hostId: playerId, maxPlayers: clampedMax, noxBonusDisplay: room.noxBonusDisplay, orenToGbpRate: room.orenToGbpRate, gbpToUsdtRate: room.gbpToUsdtRate, bundles: room.bundles },
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
  const messages: ServerMessage[] = [
    { type: 'player_joined', playerId, playerName, playerCount: room.players.size },
    playersUpdateMessage(room, room.hostId),
    { type: 'room_created', roomCode: room.code, playerId, hostId: room.hostId, maxPlayers: room.maxPlayers, noxBonusDisplay: room.noxBonusDisplay, orenToGbpRate: room.orenToGbpRate, gbpToUsdtRate: room.gbpToUsdtRate, bundles: room.bundles },
  ];
  return { room, messages };
}

export function setWallet(playerId: string, walletAddress: string): { room: Room | null; messages: ServerMessage[] } {
  const room = getPlayerRoom(playerId);
  if (!room) return { room: null, messages: [] };
  const player = room.players.get(playerId);
  if (!player) return { room: null, messages: [] };
  player.walletAddress = walletAddress;
  if (isReady(player)) clearReadyTimer(playerId);
  return { room, messages: [playersUpdateMessage(room, room.hostId)] };
}

export function markEntryFeePaid(
  playerId: string,
  bundleId: string,
  currency: 'OREN' | 'SOL'
): { room: Room | null; messages: ServerMessage[] } {
  const room = getPlayerRoom(playerId);
  if (!room) return { room: null, messages: [] };
  const player = room.players.get(playerId);
  if (!player) return { room: null, messages: [] };
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
  if (room.players.size < 1) {
    return { room: null as any, messages: [{ type: 'error', message: 'Need at least 1 player' }] };
  }
  const notReady = Array.from(room.players.values()).find(p => !isReady(p));
  if (notReady) {
    return {
      room: null as any,
      messages: [{ type: 'error', message: notReady.name + ' has not finished connecting a wallet and paying for a bundle' }],
    };
  }
  const seed = roomCode + '-' + Date.now();
  room.drawSequence = generateDrawSequence(seed);
  room.currentDrawIndex = -1;
  room.phase = 'playing';
  room.winningPlayerId = null;
  room.bonusWinnerId = null;
  room.players.forEach((player) => {
    // Each player gets however many cards their verified bundle paid
    // for — no longer a flat 3 for everyone.
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
  return { room, messages };
}

export function getPayoutAmount(room: Room, winnerId: string): number {
  if (room.isSolo) {
    const winner = room.players.get(winnerId);
    if (!winner) return 0;
    const multiplier = (winner.bundleId && room.soloMultipliers[winner.bundleId]) || DEFAULT_SOLO_MULTIPLIER;
    return winner.amountPaidOren * multiplier;
  }
  const pot = Array.from(room.players.values()).reduce((sum, p) => sum + p.amountPaidOren, 0);
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