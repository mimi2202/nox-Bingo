import { createClient } from '@supabase/supabase-js';

/**
 * Storage for guest prizes. The steps that must be atomic (create within the
 * limits, claim, expire) are Postgres functions; see
 * supabase/migrations/20261105000000_guest_prizes.sql.
 */

export type GuestPrizeStatus = 'pending' | 'claimed' | 'paid' | 'payout_failed' | 'expired';
export const GUEST_PRIZE_STATUSES: GuestPrizeStatus[] = ['pending', 'claimed', 'paid', 'payout_failed', 'expired'];

// Every column except token_hash, which never leaves the server.
export interface GuestPrizeRow {
  id: string;
  amount_oren: number;
  status: GuestPrizeStatus;
  room_code: string | null;
  guest_ip: string | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  user_id: string | null;
  wallet_address: string | null;
  payout_tx: string | null;
  payout_error: string | null;
}

export type CreatePrizeResult =
  | { result: 'created'; id: string; expires_at: string }
  | { result: 'limit_reached' | 'daily_budget' };

export type ClaimPrizeResult =
  | { result: 'claimed'; id: string; amount_oren: number; room_code: string | null }
  | { result: 'not_claimable' | 'account_already_claimed' | 'wallet_already_claimed' };

export interface CreatePrizeInput {
  tokenHash: string;
  amountOren: number;
  roomCode: string;
  guestIp: string;
  ttlHours: number;
  dailyBudgetOren: number;
}

export interface GuestPrizeStore {
  create(input: CreatePrizeInput): Promise<CreatePrizeResult>;
  /** Withdraws a prize whose token could not be delivered. */
  cancel(id: string): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<GuestPrizeRow | null>;
  /** Claims already made by this account or this wallet. */
  findExistingClaims(userId: string, walletAddress: string): Promise<(GuestPrizeRow & { token_hash: string })[]>;
  claim(tokenHash: string, userId: string, walletAddress: string): Promise<ClaimPrizeResult>;
  markPaid(id: string, txSignature: string): Promise<void>;
  markPayoutFailed(id: string, errorText: string): Promise<void>;
  expireDue(): Promise<number>;
  list(status: GuestPrizeStatus | null, limit: number): Promise<GuestPrizeRow[]>;
  findById(id: string): Promise<GuestPrizeRow | null>;
  /** Moves payout_failed back to claimed. Returns false if another retry got there first. */
  beginRetry(id: string): Promise<boolean>;
}

const PUBLIC_COLUMNS =
  'id,amount_oren,status,room_code,guest_ip,created_at,expires_at,claimed_at,user_id,wallet_address,payout_tx,payout_error';

export function createSupabaseGuestPrizeStore(): GuestPrizeStore {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (used for guest prizes).');
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const table = () => supabase.from('guest_prizes');

  function must<T>(what: string, res: { data: T; error: { message: string } | null }): T {
    if (res.error) throw new Error('[guest-prize] ' + what + ' failed: ' + res.error.message);
    return res.data;
  }

  return {
    async create(input) {
      return must('create', await supabase.rpc('create_guest_prize', {
        p_token_hash: input.tokenHash,
        p_amount_oren: input.amountOren,
        p_room_code: input.roomCode,
        p_guest_ip: input.guestIp,
        p_ttl_hours: input.ttlHours,
        p_daily_budget_oren: input.dailyBudgetOren,
      })) as CreatePrizeResult;
    },
    async cancel(id) {
      must('cancel', await table().update({ status: 'expired' }).eq('id', id).eq('status', 'pending'));
    },
    async findByTokenHash(tokenHash) {
      return must('lookup', await table().select(PUBLIC_COLUMNS).eq('token_hash', tokenHash).maybeSingle()) as GuestPrizeRow | null;
    },
    async findExistingClaims(userId, walletAddress) {
      // Both values are validated before they get here: the account id comes
      // from Supabase and the wallet has passed the base58 public key check.
      return must('claim check', await table()
        .select(PUBLIC_COLUMNS + ',token_hash')
        .or('user_id.eq.' + userId + ',wallet_address.eq.' + walletAddress)) as unknown as (GuestPrizeRow & { token_hash: string })[];
    },
    async claim(tokenHash, userId, walletAddress) {
      return must('claim', await supabase.rpc('claim_guest_prize', {
        p_token_hash: tokenHash,
        p_user_id: userId,
        p_wallet_address: walletAddress,
      })) as ClaimPrizeResult;
    },
    async markPaid(id, txSignature) {
      must('mark paid', await table().update({ status: 'paid', payout_tx: txSignature, payout_error: null }).eq('id', id));
    },
    async markPayoutFailed(id, errorText) {
      must('mark failed', await table().update({ status: 'payout_failed', payout_error: errorText }).eq('id', id));
    },
    async expireDue() {
      return must('expire', await supabase.rpc('expire_guest_prizes')) as number;
    },
    async list(status, limit) {
      let query = table().select(PUBLIC_COLUMNS).order('created_at', { ascending: false }).limit(limit);
      if (status) query = query.eq('status', status);
      return must('list', await query) as unknown as GuestPrizeRow[];
    },
    async findById(id) {
      return must('lookup', await table().select(PUBLIC_COLUMNS).eq('id', id).maybeSingle()) as GuestPrizeRow | null;
    },
    async beginRetry(id) {
      const rows = must('retry', await table()
        .update({ status: 'claimed' })
        .eq('id', id)
        .eq('status', 'payout_failed')
        .select('id')) as { id: string }[];
      return rows.length === 1;
    },
  };
}
