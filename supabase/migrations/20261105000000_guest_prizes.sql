-- Guest prizes: a signed-out player who wins a free game gets a real OREN
-- prize, held until they claim it with an account and a wallet. Nothing
-- moves on-chain until the claim, so an expired prize simply stays in the
-- treasury.

create table guest_prizes (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,        -- sha256 of the claim token; never store the token itself
  amount_oren   numeric not null check (amount_oren > 0),
  status        text not null default 'pending'
                check (status in ('pending','claimed','paid','payout_failed','expired')),
  room_code     text,
  guest_ip      text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  claimed_at    timestamptz,
  user_id       uuid references auth.users(id),
  wallet_address text,
  payout_tx     text,
  payout_error  text
);
create unique index guest_prizes_one_per_user   on guest_prizes(user_id)        where user_id is not null;
create unique index guest_prizes_one_per_wallet on guest_prizes(wallet_address) where wallet_address is not null;
create index guest_prizes_pending on guest_prizes(status, expires_at);
alter table guest_prizes enable row level security;   -- no public policies: only the server (service key) touches it


-- Creates a prize if this guest has none pending and today's budget still
-- has room. The lock makes the checks and the insert one step, so two wins
-- at the same moment can't both squeeze under a limit.
--
-- Everything except an expired prize counts toward the budget. That includes
-- payout_failed: an admin can still retry it, so the money is still committed.
create function create_guest_prize(
  p_token_hash text,
  p_amount_oren numeric,
  p_room_code text,
  p_guest_ip text,
  p_ttl_hours numeric,
  p_daily_budget_oren numeric
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_spent numeric;
  v_id uuid;
  v_expires_at timestamptz;
begin
  perform pg_advisory_xact_lock(7426001);

  -- A prize past its time must not count, even if the expiry job hasn't run.
  update guest_prizes set status = 'expired'
   where status = 'pending' and expires_at <= now();

  if exists (select 1 from guest_prizes where status = 'pending' and guest_ip = p_guest_ip) then
    return jsonb_build_object('result', 'limit_reached');
  end if;

  select coalesce(sum(amount_oren), 0) into v_spent
    from guest_prizes
   where status <> 'expired'
     and created_at >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc');

  if v_spent + p_amount_oren > p_daily_budget_oren then
    return jsonb_build_object('result', 'daily_budget');
  end if;

  insert into guest_prizes (token_hash, amount_oren, room_code, guest_ip, expires_at)
  values (p_token_hash, p_amount_oren, p_room_code, p_guest_ip, now() + make_interval(secs => p_ttl_hours * 3600))
  returning id, expires_at into v_id, v_expires_at;

  return jsonb_build_object('result', 'created', 'id', v_id, 'expires_at', v_expires_at);
end;
$$;


-- Claims a prize. A single UPDATE, so two parallel claims can't both win.
-- The unique indexes are the hard guarantee of one claim per account and
-- per wallet; losing that race comes back as a result, not an error.
create function claim_guest_prize(
  p_token_hash text,
  p_user_id uuid,
  p_wallet_address text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_amount numeric;
  v_room text;
  v_constraint text;
begin
  update guest_prizes
     set status = 'claimed', claimed_at = now(), user_id = p_user_id, wallet_address = p_wallet_address
   where token_hash = p_token_hash and status = 'pending' and expires_at > now()
   returning id, amount_oren, room_code into v_id, v_amount, v_room;

  if v_id is null then
    return jsonb_build_object('result', 'not_claimable');
  end if;

  return jsonb_build_object('result', 'claimed', 'id', v_id, 'amount_oren', v_amount, 'room_code', v_room);
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  return jsonb_build_object(
    'result',
    case when v_constraint = 'guest_prizes_one_per_wallet' then 'wallet_already_claimed' else 'account_already_claimed' end
  );
end;
$$;


-- Marks overdue pending prizes as expired. No money moves.
create function expire_guest_prizes() returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update guest_prizes set status = 'expired'
   where status = 'pending' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


-- Supabase exposes tables and functions in "public" to the browser's keys by
-- default, so close that off: these move money and must be server-only.
revoke all on table guest_prizes from anon, authenticated;
grant all on table guest_prizes to service_role;

revoke all on function create_guest_prize(text, numeric, text, text, numeric, numeric) from public, anon, authenticated;
revoke all on function claim_guest_prize(text, uuid, text) from public, anon, authenticated;
revoke all on function expire_guest_prizes() from public, anon, authenticated;
grant execute on function create_guest_prize(text, numeric, text, text, numeric, numeric) to service_role;
grant execute on function claim_guest_prize(text, uuid, text) to service_role;
grant execute on function expire_guest_prizes() to service_role;
