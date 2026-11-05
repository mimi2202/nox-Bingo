import { createPublicKey, verify } from 'crypto';
import { PublicKey } from '@solana/web3.js';

// Proof that a connection controls the wallet it names: the player's wallet
// signs a message containing a one-time, per-connection challenge. Uses
// Node's built-in ed25519 support, no extra dependency.

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Returns the canonical address if raw is a real Solana public key, else null.
export function cleanWallet(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 32 || raw.length > 44) return null;
  try {
    return new PublicKey(raw).toBase58() === raw ? raw : null;
  } catch {
    return null;
  }
}

export function challengeMessage(nonce: string): string {
  return 'NoxBingo wallet verification\nChallenge: ' + nonce;
}

export function verifyWalletSignature(walletAddress: string, message: string, signatureBase64: unknown): boolean {
  try {
    if (typeof signatureBase64 !== 'string' || signatureBase64.length > 200) return false;
    const sig = Buffer.from(signatureBase64, 'base64');
    if (sig.length !== 64) return false;
    const pub = new PublicKey(walletAddress).toBytes();
    if (pub.length !== 32) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub)]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}