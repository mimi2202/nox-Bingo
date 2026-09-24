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
  walletAddress: string | null;
  paidEntryFee: boolean;
  bundleId: string | null;
  cardCount: number;
  amountPaidOren: number;
  paymentCurrency: 'OREN' | 'SOL' | null;
}

export interface CardBundle {
  id: string;
  cardCount: number;
  priceGBP: number;
  label: string;
}

export interface GameConfig {
  ballCap: number;
  rakePercent: number;
  bundles: CardBundle[];
  soloMultipliers: Record<string, number>;
  noxBonusDisplay: number;
  orenToGbpRate: number;
  gbpToUsdtRate: number;
}

export interface Room {
  code: string;
  hostId: string;
  maxPlayers: number;
  isSolo: boolean;
  ballCap: number;
  rakePercent: number;
  bundles: CardBundle[];
  soloMultipliers: Record<string, number>;
  noxBonusDisplay: number;
  orenToGbpRate: number;
  gbpToUsdtRate: number;
  players: Map<string, Player>;
  drawSequence: number[];
  currentDrawIndex: number;
  phase: 'waiting' | 'countdown' | 'playing' | 'finished';
  winningPlayerId: string | null;
  bonusWinnerId: string | null;
  createdAt: number;
}

export type ServerMessage =
  | { type: 'room_created'; roomCode: string; playerId: string; hostId?: string; maxPlayers?: number; noxBonusDisplay?: number; orenToGbpRate?: number; gbpToUsdtRate?: number; bundles?: CardBundle[] }
  | { type: 'player_joined'; playerId: string; playerName: string; playerCount: number }
  | { type: 'player_left'; playerId: string; playerName: string; playerCount: number }
  | { type: 'game_starting'; countdown: number }
  | { type: 'cards_dealt'; cards: BingoCard[] }
  | { type: 'ball_drawn'; ball: number; letter: string; index: number }
  | { type: 'bingo'; winnerId: string; winnerName: string; cardIndex: number }
  | { type: 'nox_bonus'; winnerId: string; winnerName: string; cardIndex: number }
  | { type: 'game_over'; winnerId: string | null; winnerName: string | null }
  // Sent once the server has actually sent OREN to the winner's wallet.
  | { type: 'payout_sent'; winnerId: string; txSignature: string; amount: number }
  | { type: 'payout_error'; message: string }
  | { type: 'entry_fee_confirmed'; playerId: string; cardCount: number }
  | { type: 'entry_fee_rejected'; message: string }
  | { type: 'removed_from_room'; reason: 'wallet_timeout' | 'fee_timeout' | 'host_removed' }
  | { type: 'error'; message: string }
  | {
      type: 'players_update';
      players: {
        id: string;
        name: string;
        walletAddress: string | null;
        paidEntryFee: boolean;
        bundleId: string | null;
        cardCount: number;
      }[];
      hostId?: string | null;
      maxPlayers: number;
    };

export type ClientMessage =
  | { type: 'create_room'; playerName: string; walletAddress?: string; maxPlayers?: number; isSolo?: boolean }
  | { type: 'join_room'; roomCode: string; playerName: string; walletAddress?: string }
  | { type: 'set_wallet'; walletAddress: string }
  | { type: 'submit_entry_fee'; txSignature: string; bundleId: string; currency: 'OREN' | 'SOL' }
  | { type: 'remove_player'; playerId: string }
  | { type: 'start_game' }
  | { type: 'claim_bingo'; cardIndex: number }
  | { type: 'leave_room' };