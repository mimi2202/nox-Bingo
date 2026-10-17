import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';


const OREN_MINT = new PublicKey('6EqY4SZKesXPzVJD3BhdFszYqnossy6t1gU43GSBqkQs');
const DECIMALS = 8;

// A payment can only be submitted as an entry fee within this long of
// being confirmed on-chain. Combined with the one-time-use signature
// check and the wallet-ownership proof, this stops old public
// transactions being dug up and reused. It was 10 minutes; raised to 60
// so a player whose check failed during an outage can still confirm the
// payment they already made instead of being charged again.
const MAX_TX_AGE_SECONDS = 60 * 60;

// ── RPC endpoints ──────────────────────────────────────────────────
// SOLANA_RPC_URL is the main provider (Helius). SOLANA_RPC_FALLBACK_URLS
// can list more providers, comma-separated. The public Solana endpoint
// for the same network is always tried last, so a blocked or down
// provider never stops payments and payouts completely.
const PRIMARY_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
if (!process.env.SOLANA_RPC_URL) {
  console.warn('[rpc] SOLANA_RPC_URL is not set, using public DEVNET. Mainnet payments will not verify.');
}
const PUBLIC_RPC_URL = /devnet/i.test(PRIMARY_RPC_URL)
  ? 'https://api.devnet.solana.com'
  : 'https://api.mainnet-beta.solana.com';

const RPC_URLS = Array.from(new Set([
  PRIMARY_RPC_URL,
  ...(process.env.SOLANA_RPC_FALLBACK_URLS || '').split(',').map(u => u.trim()).filter(Boolean),
  PUBLIC_RPC_URL,
]));

const connections = RPC_URLS.map(url => ({ url, connection: new Connection(url, 'confirmed') }));

/** Host plus the last 4 characters of any API key, safe to print in logs. */
function describeRpc(url: string): string {
  try {
    const u = new URL(url);
    const key = u.searchParams.get('api-key');
    return key ? `${u.host} (key …${key.slice(-4)})` : u.host;
  } catch {
    return 'invalid RPC URL';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs an RPC call against each endpoint in order until one works.
 * With treatNullAsMiss, a null answer (e.g. "transaction not found yet")
 * also moves on to the next endpoint, since providers can lag each other.
 */
async function withFallback<T>(
  label: string,
  call: (connection: Connection) => Promise<T>,
  treatNullAsMiss = false
): Promise<T> {
  let lastError: unknown = null;
  let sawNull = false;
  for (const { url, connection } of connections) {
    try {
      const result = await call(connection);
      if (treatNullAsMiss && result === null) {
        sawNull = true;
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      console.warn(`[rpc] ${label} failed on ${describeRpc(url)}: ${errorText(err)}`);
    }
  }
  if (sawNull) return null as T;
  throw lastError ?? new Error(`${label} failed on every RPC endpoint`);
}

// Logs which endpoints the server is using and whether each one answers,
// so a wrong or blocked key shows up in Render's logs at startup.
async function checkRpcEndpoints() {
  for (const { url, connection } of connections) {
    try {
      const slot = await connection.getSlot();
      console.log(`[rpc] OK ${describeRpc(url)} (slot ${slot})`);
    } catch (err) {
      console.warn(`[rpc] FAILED ${describeRpc(url)}: ${errorText(err)}`);
    }
  }
}
void checkRpcEndpoints();

function loadTreasuryKeypair(): Keypair {
  const secret = process.env.SOLANA_SERVER_SECRET_KEY;
  if (!secret) {
    throw new Error(
      'SOLANA_SERVER_SECRET_KEY is not set. This must be the private key for ' +
        'the Gahk26...sVz treasury wallet.'
    );
  }
  try {
    const arr = JSON.parse(secret);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    return Keypair.fromSecretKey(bs58.decode(secret));
  }
}

const treasuryKeypair = loadTreasuryKeypair();

export const TREASURY_PUBLIC_KEY = treasuryKeypair.publicKey.toBase58();

/**
 * Shared transfer logic behind both payWinner and payJackpot — same
 * treasury-to-wallet OREN transfer either way, just called from two
 * different places in the payout flow and logged distinctly so the
 * two kinds of payout stay tellable apart in server logs/history.
 *
 * The transaction is built and signed ONCE, then that same signed
 * transaction is sent through the endpoints in turn. Solana never runs
 * the same signed transaction twice, so trying another endpoint can
 * never pay the winner twice.
 */
async function sendOrenTransfer(recipientWalletAddress: string, amountUiTokens: number): Promise<string> {
  const recipientPubkey = new PublicKey(recipientWalletAddress);
  const treasuryAta = await getAssociatedTokenAddress(OREN_MINT, treasuryKeypair.publicKey);
  const recipientAta = await getAssociatedTokenAddress(OREN_MINT, recipientPubkey);

  const tx = new Transaction();

  const recipientAtaInfo = await withFallback('getAccountInfo', c => c.getAccountInfo(recipientAta));
  if (!recipientAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(treasuryKeypair.publicKey, recipientAta, recipientPubkey, OREN_MINT)
    );
  }

  const rawAmount = BigInt(Math.round(amountUiTokens * 10 ** DECIMALS));
  tx.add(
    createTransferCheckedInstruction(
      treasuryAta,
      OREN_MINT,
      recipientAta,
      treasuryKeypair.publicKey,
      rawAmount,
      DECIMALS
    )
  );

  const { blockhash, lastValidBlockHeight } = await withFallback(
    'getLatestBlockhash',
    c => c.getLatestBlockhash('confirmed')
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = treasuryKeypair.publicKey;
  tx.sign(treasuryKeypair);
  const rawTx = tx.serialize();
  const signature = bs58.encode(tx.signature!);

  await withFallback('sendRawTransaction', c => c.sendRawTransaction(rawTx, { maxRetries: 5 }));

  const confirmation = await withFallback(
    'confirmTransaction',
    c => c.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  );
  if (confirmation.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)} (${signature})`);
  }
  return signature;
}

/**
 * Sends OREN from the treasury wallet directly to a winner's wallet.
 * Creates the winner's associated token account first if needed.
 */
export async function payWinner(winnerWalletAddress: string, amountUiTokens: number): Promise<string> {
  const sig = await sendOrenTransfer(winnerWalletAddress, amountUiTokens);
  console.log(`[payout] Sent ${amountUiTokens} OREN to ${winnerWalletAddress} — ${sig}`);
  return sig;
}

/**
 * Sends the fixed jackpot amount from the treasury to a winner's
 * wallet. This is a SEPARATE transaction from the normal payWinner
 * payout for the same game — the game winner always gets their normal
 * payout first; this is purely additive on top when the jackpot hits.
 * Call this only after RoomManager.drawBall has returned a
 * 'jackpot_won' message for this game.
 */
export async function payJackpot(winnerWalletAddress: string, amountUiTokens: number): Promise<string> {
  const sig = await sendOrenTransfer(winnerWalletAddress, amountUiTokens);
  console.log(`[JACKPOT] Sent ${amountUiTokens} OREN to ${winnerWalletAddress} — ${sig}`);
  return sig;
}

/** Returns an error string if the transaction is missing a timestamp or too old, else null. */
function checkFresh(blockTime: number | null | undefined): string | null {
  if (blockTime === null || blockTime === undefined) {
    return 'Transaction timestamp is not available yet — try again in a few seconds.';
  }
  const ageSeconds = Math.floor(Date.now() / 1000) - blockTime;
  if (ageSeconds > MAX_TX_AGE_SECONDS) {
    return 'This payment is too old to be used for an entry. Contact support for a refund.';
  }
  return null;
}

function getParsedTransaction(txSignature: string) {
  return withFallback(
    'getParsedTransaction',
    c => c.getParsedTransaction(txSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
    true
  );
}

/**
 * Independently verifies an entry-fee payment on-chain. Never trust a
 * client's claim that a transaction succeeded — always check this
 * before marking a player as paid.
 *
 * Matches accounts by their actual position in the transaction
 * (resolved to a real address via message.accountKeys) rather than
 * the `owner` field on token balance entries — that field is optional
 * and not always populated depending on RPC provider/version, which
 * was causing genuine, successfully-debited payments to be rejected
 * as unverifiable because the match could never be found.
 *
 * NOTE: this only proves the payment happened and is recent. That each
 * signature is used only once is enforced by the caller
 * (usedSignatures.claimSignature) — keep that call in place.
 */
export async function verifyEntryFeePayment(
  txSignature: string,
  expectedPayerWallet: string,
  expectedAmountUiTokens: number
): Promise<{ ok: boolean; reason?: string }> {
  const tx = await getParsedTransaction(txSignature);

  if (!tx) return { ok: false, reason: 'Transaction not found (not confirmed yet, or invalid signature).' };
  if (tx.meta?.err) return { ok: false, reason: 'Transaction failed on-chain.' };

  const staleReason = checkFresh(tx.blockTime);
  if (staleReason) return { ok: false, reason: staleReason };

  const treasuryAta = (await getAssociatedTokenAddress(OREN_MINT, treasuryKeypair.publicKey)).toBase58();
  const payerPubkey = new PublicKey(expectedPayerWallet);
  const payerAta = (await getAssociatedTokenAddress(OREN_MINT, payerPubkey)).toBase58();

  const accountKeys = tx.transaction.message.accountKeys;
  function accountAtIndex(index: number): string | null {
    const entry = accountKeys[index];
    return entry ? entry.pubkey.toBase58() : null;
  }

  const pre = tx.meta?.preTokenBalances || [];
  const post = tx.meta?.postTokenBalances || [];

  const treasuryPre = pre.find(b => accountAtIndex(b.accountIndex) === treasuryAta && b.mint === OREN_MINT.toBase58());
  const treasuryPost = post.find(b => accountAtIndex(b.accountIndex) === treasuryAta && b.mint === OREN_MINT.toBase58());

  if (!treasuryPost) {
    return { ok: false, reason: 'Transaction did not touch the treasury OREN account.' };
  }

  const preAmount = treasuryPre ? Number(treasuryPre.uiTokenAmount.amount) : 0;
  const postAmount = Number(treasuryPost.uiTokenAmount.amount);
  const delta = postAmount - preAmount;
  const expectedRaw = Math.round(expectedAmountUiTokens * 10 ** DECIMALS);

  if (delta < expectedRaw) {
    return {
      ok: false,
      reason: `Treasury received ${delta / 10 ** DECIMALS} OREN, expected at least ${expectedAmountUiTokens}.`,
    };
  }

  const payerPre = pre.find(b => accountAtIndex(b.accountIndex) === payerAta && b.mint === OREN_MINT.toBase58());
  const payerPost = post.find(b => accountAtIndex(b.accountIndex) === payerAta && b.mint === OREN_MINT.toBase58());
  const payerPreAmount = payerPre ? Number(payerPre.uiTokenAmount.amount) : 0;
  const payerPostAmount = payerPost ? Number(payerPost.uiTokenAmount.amount) : 0;

  // The payer's own balance must have dropped by the full amount, not
  // merely "by something" — otherwise a payment from someone else that
  // happens to touch this wallet's account could pass for theirs.
  if (payerPreAmount - payerPostAmount < expectedRaw) {
    return { ok: false, reason: "Payer's OREN balance did not decrease by the expected amount — this doesn't look like their payment." };
  }

  return { ok: true };
}

/**
 * Verifies a native SOL payment to the treasury, same approach as the
 * OREN check above — match accounts by their real resolved address,
 * not any optional metadata field, and confirm the treasury's SOL
 * balance genuinely increased by at least the expected amount.
 *
 * expectedLamports should already account for a small tolerance
 * (built in by the caller) since the SOL amount is computed from a
 * live price that can move slightly between the moment the player
 * was quoted a price and the moment this verification runs.
 */
export async function verifySolEntryFeePayment(
  txSignature: string,
  expectedPayerWallet: string,
  expectedLamports: number
): Promise<{ ok: boolean; reason?: string }> {
  const tx = await getParsedTransaction(txSignature);

  if (!tx) return { ok: false, reason: 'Transaction not found (not confirmed yet, or invalid signature).' };
  if (tx.meta?.err) return { ok: false, reason: 'Transaction failed on-chain.' };

  const staleReason = checkFresh(tx.blockTime);
  if (staleReason) return { ok: false, reason: staleReason };

  const accountKeys = tx.transaction.message.accountKeys;
  const treasuryAddress = treasuryKeypair.publicKey.toBase58();
  const payerAddress = expectedPayerWallet;

  const treasuryIndex = accountKeys.findIndex(entry => entry.pubkey.toBase58() === treasuryAddress);
  const payerIndex = accountKeys.findIndex(entry => entry.pubkey.toBase58() === payerAddress);

  if (treasuryIndex === -1) {
    return { ok: false, reason: 'Transaction did not touch the treasury wallet.' };
  }
  if (payerIndex === -1) {
    return { ok: false, reason: "Transaction did not include the payer's wallet." };
  }

  const preBalances = tx.meta?.preBalances || [];
  const postBalances = tx.meta?.postBalances || [];

  const treasuryDelta = (postBalances[treasuryIndex] ?? 0) - (preBalances[treasuryIndex] ?? 0);
  if (treasuryDelta < expectedLamports) {
    return {
      ok: false,
      reason: `Treasury received ${treasuryDelta / 1e9} SOL, expected at least ${expectedLamports / 1e9}.`,
    };
  }

  const payerDelta = (preBalances[payerIndex] ?? 0) - (postBalances[payerIndex] ?? 0);
  if (payerDelta < expectedLamports) {
    return { ok: false, reason: "Payer's SOL balance did not decrease by enough to match this payment." };
  }

  return { ok: true };
}
