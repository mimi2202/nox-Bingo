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
 * before marking a player as paid. Confirms:
 *  - the transaction actually landed and succeeded
 *  - it's a real transfer of the OREN mint
 *  - it moved at least the required amount into the treasury's ATA
 *  - the treasury ATA's balance genuinely increased by that much
 *    (checked via pre/post balances, not just instruction contents,
 *    so a malformed/no-op instruction can't fake a pass)
 *
 * Does NOT verify the sender is `expectedPayerWallet` beyond checking
 * their token balance decreased — anyone could technically pay on
 * someone else's behalf, which is harmless here (the treasury still
 * gets paid) so it's intentionally not a rejection condition.
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

  const pre = tx.meta?.preTokenBalances || [];
  const post = tx.meta?.postTokenBalances || [];

  const treasuryPre = pre.find(b => b.owner === treasuryKeypair.publicKey.toBase58() && b.mint === OREN_MINT.toBase58());
  const treasuryPost = post.find(b => b.owner === treasuryKeypair.publicKey.toBase58() && b.mint === OREN_MINT.toBase58());

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

  const payerPre = pre.find(b => b.owner === expectedPayerWallet && b.mint === OREN_MINT.toBase58());
  const payerPost = post.find(b => b.owner === expectedPayerWallet && b.mint === OREN_MINT.toBase58());
  const payerPreAmount = payerPre ? Number(payerPre.uiTokenAmount.amount) : 0;
  const payerPostAmount = payerPost ? Number(payerPost.uiTokenAmount.amount) : 0;

  if (payerPostAmount >= payerPreAmount) {
    return { ok: false, reason: "Payer's OREN balance did not decrease — this doesn't look like their payment." };
  }

  return { ok: true };
}