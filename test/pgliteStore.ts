import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { ClaimPrizeResult, CreatePrizeResult, GuestPrizeRow, GuestPrizeStore } from '../src/guestPrizeStore';

const COLUMNS =
  'id,amount_oren,status,room_code,guest_ip,created_at,expires_at,claimed_at,user_id,wallet_address,payout_tx,payout_error';

/** A real Postgres (embedded) with what Supabase provides, plus the real migration. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  await db.exec(readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261105000000_guest_prizes.sql'), 'utf8'));
  return db;
}

function toRow<T extends { amount_oren: unknown }>(row: T): T {
  return { ...row, amount_oren: Number(row.amount_oren) };
}

/** The store interface over the same SQL functions the Supabase store calls. */
export function createPgliteStore(db: PGlite): GuestPrizeStore {
  async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await db.query<T>(sql, params)).rows;
  }
  async function fn<T>(sql: string, params: unknown[]): Promise<T> {
    return (await rows<{ r: T }>(sql, params))[0].r;
  }

  return {
    create: input =>
      fn<CreatePrizeResult>('select create_guest_prize($1,$2,$3,$4,$5,$6) as r', [
        input.tokenHash, input.amountOren, input.roomCode, input.guestIp, input.ttlHours, input.dailyBudgetOren,
      ]),
    async cancel(id) {
      await rows(`update guest_prizes set status='expired' where id=$1 and status='pending'`, [id]);
    },
    async findByTokenHash(tokenHash) {
      const [row] = await rows<GuestPrizeRow>(`select ${COLUMNS} from guest_prizes where token_hash=$1`, [tokenHash]);
      return row ? toRow(row) : null;
    },
    async findExistingClaims(userId, walletAddress) {
      const found = await rows<GuestPrizeRow & { token_hash: string }>(
        `select ${COLUMNS},token_hash from guest_prizes where user_id=$1 or wallet_address=$2`,
        [userId, walletAddress]
      );
      return found.map(toRow);
    },
    claim: (tokenHash, userId, walletAddress) =>
      fn<ClaimPrizeResult>('select claim_guest_prize($1,$2,$3) as r', [tokenHash, userId, walletAddress]),
    async markPaid(id, txSignature) {
      await rows(`update guest_prizes set status='paid', payout_tx=$2, payout_error=null where id=$1`, [id, txSignature]);
    },
    async markPayoutFailed(id, errorText) {
      await rows(`update guest_prizes set status='payout_failed', payout_error=$2 where id=$1`, [id, errorText]);
    },
    expireDue: () => fn<number>('select expire_guest_prizes() as r', []),
    async list(status, limit) {
      const found = status
        ? await rows<GuestPrizeRow>(`select ${COLUMNS} from guest_prizes where status=$1 order by created_at desc limit $2`, [status, limit])
        : await rows<GuestPrizeRow>(`select ${COLUMNS} from guest_prizes order by created_at desc limit $1`, [limit]);
      return found.map(toRow);
    },
    async findById(id) {
      const [row] = await rows<GuestPrizeRow>(`select ${COLUMNS} from guest_prizes where id=$1`, [id]);
      return row ? toRow(row) : null;
    },
    async beginRetry(id) {
      const updated = await rows(`update guest_prizes set status='claimed' where id=$1 and status='payout_failed' returning id`, [id]);
      return updated.length === 1;
    },
  };
}
