import { createClient } from '@supabase/supabase-js';

/**
 * Leaderboard stats for SIGNED-IN players only.
 *
 * The browser sends its Supabase login token over the game connection
 * ("identify"). The server asks Supabase whether that token is real —
 * the token cannot be forged — and only then remembers which account the
 * connection belongs to. Results are written by the server (service
 * role) through record_game_result(), which the browser cannot call.
 * Guests are never identified, so they never appear on the leaderboard.
 */

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (used for leaderboard stats).');
}
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/** Returns the Supabase user id for a valid login token, or null. */
export async function userIdFromToken(accessToken: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) return null;
    return data.user.id;
  } catch (err) {
    console.error('[stats] token check failed:', err);
    return null;
  }
}

/**
 * Adds to a player's leaderboard numbers. Best-effort: a failure is
 * logged and never affects the game or a payout.
 */
export async function recordGameResult(
  userId: string,
  gamesPlayed: number,
  gamesWon: number,
  winningsOren: number
): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_game_result', {
      p_user: userId,
      p_played: gamesPlayed,
      p_won: gamesWon,
      p_winnings: winningsOren,
    });
    if (error) console.error('[stats] record_game_result failed (is leaderboard-stats.sql applied?):', error.message);
  } catch (err) {
    console.error('[stats] record_game_result threw:', err);
  }
}