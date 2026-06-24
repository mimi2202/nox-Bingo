import { v4 as uuidv4 } from 'uuid';
import { Room, Player, BingoCard, ServerMessage } from './types';
import { generateCards, generateDrawSequence, checkForWin, getNearMissCount, autoDaub, getLetterForNumber } from './GameEngine';
const rooms = new Map<string, Room>();
const playerRooms = new Map<string, string>();
const roomTimers = new Map<string, NodeJS.Timeout>();
function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  if (rooms.has(code)) return generateRoomCode();
  return code;
}
function getPlayerList(room: Room): { id: string; name: string }[] {
  return Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
  }));
}
function clearRoomTimer(roomCode: string) {
  const timer = roomTimers.get(roomCode);
  if (timer) {
    clearTimeout(timer);
    roomTimers.delete(roomCode);
  }
}
export function createRoom(playerId: string, playerName: string): { room: Room; messages: ServerMessage[] } {
  const code = generateRoomCode();
  const player: Player = {
    id: playerId,
    name: playerName,
    cards: [],
    connected: true,
  };
  const players = new Map<string, Player>();
  players.set(playerId, player);
  const room: Room = {
    code,
    hostId: playerId,
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
  // Set 3-minute expiry timer
  const timer = setTimeout(() => {
    const existingRoom = rooms.get(code);
    if (existingRoom && existingRoom.phase === 'waiting' && existingRoom.players.size <= 1) {
      rooms.delete(code);
      console.log('Room expired: ' + code);
    }
  }, 3 * 60 * 1000);
  roomTimers.set(code, timer);
  return {
    room,
    messages: [
      { type: 'room_created', roomCode: code, playerId, hostId: playerId },
      { type: 'players_update', players: getPlayerList(room), hostId: playerId },
    ],
  };
}
export function joinRoom(roomCode: string, playerId: string, playerName: string): { room: Room; messages: ServerMessage[] } {
  const room = rooms.get(roomCode);
  if (!room) {
    return { room: null as any, messages: [{ type: 'error', message: 'Room not found or expired' }] };
  }
  if (room.phase !== 'waiting') {
    return { room: null as any, messages: [{ type: 'error', message: 'Game already in progress' }] };
  }
  if (room.players.size >= 10) {
    return { room: null as any, messages: [{ type: 'error', message: 'Room is full (max 10 players)' }] };
  }
  const player: Player = {
    id: playerId,
    name: playerName,
    cards: [],
    connected: true,
  };
  room.players.set(playerId, player);
  playerRooms.set(playerId, roomCode);
  // Clear expiry timer since someone joined
  clearRoomTimer(roomCode);
  const messages: ServerMessage[] = [
    {
      type: 'player_joined',
      playerId,
      playerName,
      playerCount: room.players.size,
    },
    {
      type: 'players_update',
      players: getPlayerList(room),
      hostId: room.hostId,
    },
    {
      type: 'room_created',
      roomCode: room.code,
      playerId,
      hostId: room.hostId,
    },
  ];
  return { room, messages };
}
export function leaveRoom(playerId: string): { roomCode: string | null; messages: ServerMessage[] } {
  const roomCode = playerRooms.get(playerId);
  if (!roomCode) return { roomCode: null, messages: [] };
  const room = rooms.get(roomCode);
  if (!room) return { roomCode: null, messages: [] };
  const player = room.players.get(playerId);
  const wasHost = room.hostId === playerId;
  room.players.delete(playerId);
  playerRooms.delete(playerId);
  // If host leaves during an active game, end the game for everyone
  const gameEnded = wasHost && (room.phase === 'playing' || room.phase === 'countdown');
  const messages: ServerMessage[] = [
    {
      type: 'player_left',
      playerId,
      playerName: player?.name || 'Unknown',
      playerCount: room.players.size,
    },
    {
      type: 'players_update',
      players: getPlayerList(room),
      hostId: wasHost ? (room.players.size > 0 ? Array.from(room.players.keys())[0] : null) : room.hostId,
    },
  ];
  // If host left during game, end it
  if (gameEnded) {
    room.phase = 'finished';
    messages.push({
      type: 'game_over',
      winnerId: null,
      winnerName: null,
    });
  }
  // If room is empty, clean up
  if (room.players.size === 0) {
    rooms.delete(roomCode);
    clearRoomTimer(roomCode);
  } else if (wasHost) {
    // Transfer host to the next player
    const newHostId = Array.from(room.players.keys())[0];
    room.hostId = newHostId;
  }
  return { roomCode, messages };
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
  const seed = roomCode + '-' + Date.now();
  room.drawSequence = generateDrawSequence(seed);
  room.currentDrawIndex = -1;
  room.phase = 'playing';
  room.winningPlayerId = null;
  room.bonusWinnerId = null;
  const messages: ServerMessage[] = [];
  room.players.forEach((player) => {
    player.cards = generateCards(seed + '-' + player.id);
  });
  return { room, messages };
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
    {
      type: 'ball_drawn',
      ball,
      letter: getLetterForNumber(ball),
      index: nextIndex,
    },
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
      break; // Stop immediately
    }
    if (!room.bonusWinnerId) {
      for (let i = 0; i < player.cards.length; i++) {
        const card = player.cards[i];
        if (card.noxCell && !card.noxHit) {
          const noxCellValue = card.grid[card.noxCell.row][card.noxCell.col];
          if (typeof noxCellValue.value === 'number' && noxCellValue.value === ball) {
            card.noxHit = true;
            room.bonusWinnerId = pid;
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
  }
  if (nextIndex >= 24 && !gameEnded) {
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
export function getRoom(roomCode: string): Room | undefined {
  return rooms.get(roomCode);
}
export function getPlayerRoom(playerId: string): Room | undefined {
  const roomCode = playerRooms.get(playerId);
  if (!roomCode) return undefined;
  return rooms.get(roomCode);
}

