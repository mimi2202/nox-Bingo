const SOL_USD_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const HERMES_URL = 'https://hermes.pyth.network/v2/updates/price/latest';

interface HermesPriceResponse {
  parsed: {
    id: string;
    price: { price: string; expo: number; publish_time: number };
  }[];
}

// Pyth prices come as an integer plus a power-of-ten exponent (e.g.
// price=15234500000, expo=-8 means the real value is 152.345) rather
// than a plain float, to avoid floating-point precision issues.
export async function getSolUsdPrice(): Promise<number> {
  const res = await fetch(`${HERMES_URL}?ids[]=${SOL_USD_FEED_ID}`);
  if (!res.ok) {
    throw new Error(`Pyth price fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as HermesPriceResponse;
  const feed = data.parsed?.[0];
  if (!feed) {
    throw new Error('Pyth returned no price data for SOL/USD');
  }
  const price = Number(feed.price.price) * 10 ** feed.price.expo;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Pyth returned an invalid SOL/USD price');
  }
  return price;
}