/**
 * Live SOL/USD price, used to quote SOL entry fees and to verify SOL
 * payments.
 *
 * This file used to call Pyth's Hermes service, which has required a
 * paid API key since Pyth's August 2026 upgrade. It now uses free public
 * exchange prices instead, trying each source in order until one works:
 *
 *   1. Coinbase  2. Kraken  3. CoinGecko
 *
 * None of these need an API key. The file keeps its old name so the
 * existing imports in index.ts don't have to change.
 */

// How long to wait for one source before moving on to the next.
const SOURCE_TIMEOUT_MS = 4000;

// Anything outside this range is treated as a broken response, not a
// real SOL price, so a glitch can never quote a silly entry fee.
const MIN_SANE_PRICE = 1;
const MAX_SANE_PRICE = 100_000;

type PriceSource = {
  name: string;
  url: string;
  read: (data: any) => unknown;
};

const SOURCES: PriceSource[] = [
  {
    // {"data":{"amount":"105.94","base":"SOL","currency":"USD"}}
    name: 'Coinbase',
    url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    read: data => data?.data?.amount,
  },
  {
    // {"error":[],"result":{"SOLUSD":{"c":["104.28","3.59"], ...}}}
    // "c" is the last trade: [price, volume].
    name: 'Kraken',
    url: 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD',
    read: data => {
      if (Array.isArray(data?.error) && data.error.length > 0) return undefined;
      const ticker = data?.result ? Object.values(data.result)[0] as any : undefined;
      return ticker?.c?.[0];
    },
  },
  {
    // {"solana":{"usd":105.9}}
    name: 'CoinGecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    read: data => data?.solana?.usd,
  },
];

async function fetchFromSource(source: PriceSource): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const price = Number(source.read(await res.json()));
    if (!Number.isFinite(price) || price < MIN_SANE_PRICE || price > MAX_SANE_PRICE) {
      throw new Error(`unusable price value: ${price}`);
    }
    return price;
  } finally {
    clearTimeout(timer);
  }
}

export async function getSolUsdPrice(): Promise<number> {
  const failures: string[] = [];
  for (const source of SOURCES) {
    try {
      return await fetchFromSource(source);
    } catch (err) {
      const reason = err instanceof Error
        ? (err.name === 'AbortError' ? `timed out after ${SOURCE_TIMEOUT_MS}ms` : err.message)
        : String(err);
      failures.push(`${source.name}: ${reason}`);
      console.warn(`[price] ${source.name} failed (${reason}), trying next source`);
    }
  }
  throw new Error('All SOL price sources failed. ' + failures.join(' | '));
}