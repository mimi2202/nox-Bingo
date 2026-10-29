import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';

/**
 * Shareable game results ("@name just won 35 OREN on NoxBingo").
 *
 * Rows are written only here, by the server (service role), so the
 * amount on a share card is always the real one. The public share page
 * reads them with the anon key. Everything is best-effort: a failure is
 * logged and never affects the game or a payout.
 */

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (used for share results).');
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 10;

function newShareId(): string {
  // 62 * 4 = 248, so bytes >= 248 are rejected to keep the draw unbiased.
  let id = '';
  while (id.length < ID_LENGTH) {
    for (const b of randomBytes(16)) {
      if (b < 248 && id.length < ID_LENGTH) id += ID_ALPHABET[b % 62];
    }
  }
  return id;
}

export type ShareOutcome = 'win' | 'loss';
export type ShareNameSource = 'farcaster' | 'typed';

export async function createShareResult(params: {
  roomCode: string;
  outcome: ShareOutcome;
  amountOren: number;
  noxBonus: number;
  jackpotOren?: number;
}): Promise<string | null> {
  try {
    const id = newShareId();
    const { error } = await supabase.from('share_results').insert({
      id,
      room_code: params.roomCode,
      outcome: params.outcome,
      amount_oren: params.amountOren,
      nox_bonus: params.noxBonus,
      jackpot_oren: params.jackpotOren ?? 0,
    });
    if (error) {
      console.error('[share] insert failed (is the share_results table created?):', error.message);
      return null;
    }
    return id;
  } catch (err) {
    console.error('[share] insert threw:', err);
    return null;
  }
}

/** Sets the display name once. Returns false if it was already set or the write failed. */
export async function setShareName(id: string, name: string, source: ShareNameSource): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('share_results')
      .update({ display_name: name, name_source: source })
      .eq('id', id)
      .is('display_name', null)
      .select('id');
    if (error) {
      console.error('[share] name update failed:', error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (err) {
    console.error('[share] name update threw:', err);
    return false;
  }
}
