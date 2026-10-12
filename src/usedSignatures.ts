import { createClient } from '@supabase/supabase-js';


const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (used for payment replay protection).');
}
const supabase = createClient(url, key);

const seen = new Set<string>();
const SEEN_MAX = 50_000;

export type ClaimResult = 'ok' | 'duplicate' | 'error';

/**
 * Atomically marks a payment signature as used. Call this only AFTER the
 * payment has been verified on-chain. Fails closed: if the database
 * can't be reached, the entry is NOT granted.
 */
export async function claimSignature(signature: string, wallet: string, roomCode: string): Promise<ClaimResult> {
  if (seen.has(signature)) return 'duplicate';
  // Reserve immediately so two concurrent submissions of the same
  // signature can't both get past this point in this process.
  seen.add(signature);
  if (seen.size > SEEN_MAX) {
    seen.clear();
    seen.add(signature);
  }

  const { error } = await supabase
    .from('used_entry_signatures')
    .insert({ signature, wallet, room_code: roomCode });

  if (!error) return 'ok';
  // 23505 = unique_violation: this signature was already used.
  if (error.code === '23505') return 'duplicate';

  seen.delete(signature);
  console.error('[replay-protection] could not record signature (is security-fixes.sql applied?):', error.message);
  return 'error';
}

export type PayoutKind = 'prize' | 'jackpot';
export type PayoutStatus = 'sent' | 'failed' | 'unconfirmed';

/**
 * Best-effort payout ledger. Never throws and never blocks a payout
 * from being attempted — if the database is down the payout still
 * goes out and the console log is the fallback record.
 */
export async function startPayoutRecord(
  kind: PayoutKind,
  roomCode: string,
  wallet: string,
  amountOren: number
): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from('payout_log')
      .insert({ kind, room_code: roomCode, wallet, amount_oren: amountOren, status: 'pending' })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[payout_log] insert failed:', error?.message);
      return null;
    }
    return data.id as number;
  } catch (err) {
    console.error('[payout_log] insert threw:', err);
    return null;
  }
}

export async function finishPayoutRecord(
  id: number | null,
  status: PayoutStatus,
  signature: string | null,
  errorText?: string
): Promise<void> {
  if (id === null) return;
  try {
    const { error } = await supabase
      .from('payout_log')
      .update({
        status,
        signature,
        error: errorText ? errorText.slice(0, 500) : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) console.error('[payout_log] update failed:', error.message);
  } catch (err) {
    console.error('[payout_log] update threw:', err);
  }
}