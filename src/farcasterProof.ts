import { createPublicKey, verify } from 'crypto';
import { PublicKey } from '@solana/web3.js';

/**
 * Workaround for a Farcaster wallet bug.
 *
 * When asked to sign our plain-text challenge, Farcaster's Solana wallet
 * treats the text as base64 and signs the decoded bytes instead of the
 * text itself. The signature is real and made by the player's own key,
 * it just covers different bytes, so the normal check rejects it.
 *
 * This accepts that form too. It is still a valid ownership proof: the
 * signed bytes come straight from this connection's challenge, which
 * contains a fresh random code, so nobody can reuse an old signature or
 * produce one without the wallet's private key.
 *
 * Uses Node's built-in Ed25519 support, so no extra packages.
 */
export function verifyFarcasterBase64Quirk(
  walletAddress: string,
  challenge: string,
  signatureBase64: unknown
): boolean {
  if (typeof signatureBase64 !== 'string' || signatureBase64.length > 200) return false;
  try {
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64) return false;

    const publicKey = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(new PublicKey(walletAddress).toBytes()).toString('base64url'),
      },
      format: 'jwk',
    });

    // Exactly what Farcaster signs: the challenge text read as base64,
    // skipping every character that isn't valid base64.
    const signedBytes = Buffer.from(challenge, 'base64');
    if (signedBytes.length === 0) return false;

    return verify(null, signedBytes, publicKey, signature);
  } catch {
    return false;
  }
}