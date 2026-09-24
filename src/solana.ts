import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';


const OREN_MINT = new PublicKey('6EqY4SZKesXPzVJD3BhdFszYqnossy6t1gU43GSBqkQs');
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const DECIMALS = 8;

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

const connection = new Connection(RPC_URL, 'confirmed');
const treasuryKeypair = loadTreasuryKeypair();

export const TREASURY_PUBLIC_KEY = treasuryKeypair.publicKey.toBase58();

/**
 * Sends OREN from the treasury wallet directly to a winner's wallet.
 * Creates the winner's associated token account first if needed.
 */
export async function payWinner(winnerWalletAddress: string, amountUiTokens: number): Promise<string> {
  const winnerPubkey = new PublicKey(winnerWalletAddress);
  const treasuryAta = await getAssociatedTokenAddress(OREN_MINT, treasuryKeypair.publicKey);
  const winnerAta = await getAssociatedTokenAddress(OREN_MINT, winnerPubkey);

  const tx = new Transaction();

  const winnerAtaInfo = await connection.getAccountInfo(winnerAta);
  if (!winnerAtaInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(treasuryKeypair.publicKey, winnerAta, winnerPubkey, OREN_MINT)
    );
  }

  const rawAmount = BigInt(Math.round(amountUiTokens * 10 ** DECIMALS));
  tx.add(
    createTransferCheckedInstruction(
      treasuryAta,
      OREN_MINT,
      winnerAta,
      treasuryKeypair.publicKey,
      rawAmount,
      DECIMALS
    )
  );

  return sendAndConfirmTransaction(connection, tx, [treasuryKeypair], { commitment: 'confirmed' });
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
 */
export async function verifyEntryFeePayment(
  txSignature: string,
  expectedPayerWallet: string,
  expectedAmountUiTokens: number
): Promise<{ ok: boolean; reason?: string }> {
  const tx = await connection.getParsedTransaction(txSignature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) return { ok: false, reason: 'Transaction not found (not confirmed yet, or invalid signature).' };
  if (tx.meta?.err) return { ok: false, reason: 'Transaction failed on-chain.' };

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

  if (payerPostAmount >= payerPreAmount) {
    return { ok: false, reason: "Payer's OREN balance did not decrease — this doesn't look like their payment." };
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
  const tx = await connection.getParsedTransaction(txSignature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) return { ok: false, reason: 'Transaction not found (not confirmed yet, or invalid signature).' };
  if (tx.meta?.err) return { ok: false, reason: 'Transaction failed on-chain.' };

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