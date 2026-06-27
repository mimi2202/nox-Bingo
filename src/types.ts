// Card generation
export function generateColumn(min: number, max: number, count: number): number[] {
  const numbers: number[] = [];
  for (let i = min; i <= max; i++) numbers.push(i);
  return shuffle(numbers).slice(0, count);
}

export function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export interface BingoCell {
  value: number | 'FREE';
  marked: boolean;
  isFreeSpace: boolean;
}

export interface BingoCard {
  id: string;
  grid: BingoCell[][];
  noxCell: { row: number; col: number } | null;
  noxHit: boolean;
}

export interface Player {
  id: string;
  name: string;
  cards: BingoCard[];
  connected: boolean;
}

export interface Room {
  bingoPrize: number;
  noxPrize: number;
  code: string;
  hostId: string;
  players: Map<string, Player>;
  drawSequence: number[];
  currentDrawIndex: number;
  phase: 'waiting' | 'countdown' | 'playing' | 'finished';
  winningPlayerId: string | null;
  bonusWinnerId: string | null;
  createdAt: number;
}

export type ServerMessage =
  | { type: 'room_created'; roomCode: string; playerId: string; hostId?: string; bingoPrize?: number; noxPrize?: number }
  | { type: 'player_joined'; playerId: string; playerName: string; playerCount: number }
  | { type: 'player_left'; playerId: string; playerName: string; playerCount: number }
  | { type: 'game_starting'; countdown: number }
  | { type: 'cards_dealt'; cards: BingoCard[] }
  | { type: 'ball_drawn'; ball: number; letter: string; index: number }
  | { type: 'bingo'; winnerId: string; winnerName: string; cardIndex: number }
  | { type: 'nox_bonus'; winnerId: string; winnerName: string; cardIndex: number }
  | { type: 'game_over'; winnerId: string | null; winnerName: string | null }
  | { type: 'error'; message: string }
  | { type: 'players_update'; players: { id: string; name: string }[]; hostId?: string | null };

export type ClientMessage =
  | { type: 'create_room'; playerName: string; prizeTier?: string }
  | { type: 'join_room'; roomCode: string; playerName: string }
  | { type: 'start_game' }
  | { type: 'claim_bingo'; cardIndex: number }
  | { type: 'leave_room' };






