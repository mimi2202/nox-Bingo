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
  // Connected Solana wallet — where prize payouts get sent, and where
  // the entry fee payment must come from.
  walletAddress: string | null;
  // True only once the server has independently verified this
  // player's bundle payment on-chain — never set from a client's say-so.
  paidEntryFee: boolean;
  // Which bundle they paid for, and how many cards that entitles them
  // to. Both are derived server-side from the verified bundleId at
  // payment time — never trust a client-supplied cardCount directly.
  bundleId: string | null;
  cardCount: number;
  // OREN-EQUIVALENT value of their stake, always computed from the
  // bundle's GBP price divided by the room's OREN rate — the same
  // number regardless of which currency they actually paid in. This
  // is what makes multiplayer pot math and solo payout math work
  // identically whether someone paid in OREN or in SOL.
  amountPaidOren: number;
  // Which currency they actually signed a transaction in — for
  // record-keeping only, doesn't affect payout math.
  paymentCurrency: 'OREN' | 'SOL' | null;
}

export interface CardBundle {
  id: string;
  cardCount: number;
  // The real price, in GBP. OREN's own value floats until it's
  // actually circulating, so GBP — not a token amount — is the
  // source of truth here. OREN and SOL prices are both derived from
  // this at payment time.
  priceGBP: number;
  label: string;
}

// Everything the admin dashboard can edit. A room snapshots this at
// creation time (see RoomManager.createRoom) — later admin changes
// only affect rooms created after the change, never ones in progress.
export interface GameConfig {
  ballCap: number;
  rakePercent: number;
  bundles: CardBundle[];
  soloMultipliers: Record<string, number>;
  noxBonusDisplay: number;
  // How much one OREN is worth, in GBP. OREN payments convert
  // directly through this rate. Admin-set because OREN has no real
  // market price yet.
  orenToGbpRate: number;
  // How many USDT one GBP is worth. Used only as a bridge for SOL
  // pricing — a bundle's GBP price times this gives its USDT price,
  // which then divides by the live SOL/USD price (from Pyth) to get
  // the actual SOL amount to charge. Fixed/admin-set rather than a
  // second live feed, to keep this simple — update it manually if it
  // drifts too far from the real rate.
  gbpToUsdtRate: number;
}

export interface Room {
  code: string;
  hostId: string;
  maxPlayers: number;
  // A solo room has exactly one player, connects a wallet and pays
  // for a bundle same as multiplayer, but the payout on a win is a
  // fixed multiplier of their own stake instead of a shared pot split.
  isSolo: boolean;
  // Config snapshot, captured once at room creation — see GameConfig.
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
  // currency tells the server which verification path to use — OREN
  // (SPL token transfer) or SOL (native transfer, converted through
  // the live SOL/USD price at the moment of verification).
  | { type: 'submit_entry_fee'; txSignature: string; bundleId: string; currency: 'OREN' | 'SOL' }
  | { type: 'remove_player'; playerId: string }
  | { type: 'start_game' }
  | { type: 'claim_bingo'; cardIndex: number }
  | { type: 'leave_room' };