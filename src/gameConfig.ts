import { createClient } from '@supabase/supabase-js';
import { GameConfig, CardBundle } from './types';

const DEFAULT_CONFIG: GameConfig = {
  ballCap: 25,
  rakePercent: 0.15,
  bundles: [
    { id: 'single', cardCount: 1, priceOren: 3, label: '1 Card' },
    { id: 'triple', cardCount: 3, priceOren: 5, label: '3 Cards' },
    { id: 'five', cardCount: 5, priceOren: 8, label: '5 Cards' },
  ],
  soloMultipliers: { single: 15, triple: 6, five: 3.5 },
  noxBonusDisplay: 25,
};

function loadSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for the admin config store. ' +
        'Use the service role key (not the anon key) — the server needs to read/write ' +
        'game_config directly, bypassing row-level security.'
    );
  }
  return createClient(url, key);
}

const supabase = loadSupabase();

// In-memory copy new rooms read from — updated immediately on a
// successful admin save, and loaded fresh once at server startup.
let currentConfig: GameConfig = DEFAULT_CONFIG;

export function getConfig(): GameConfig {
  return currentConfig;
}

export async function loadConfigFromDb(): Promise<void> {
  const { data, error } = await supabase.from('game_config').select('data').eq('id', 1).single();

  if (error || !data) {
    console.warn('No game_config row found, seeding defaults:', error?.message);
    await supabase.from('game_config').upsert({ id: 1, data: DEFAULT_CONFIG });
    currentConfig = DEFAULT_CONFIG;
    return;
  }

  currentConfig = { ...DEFAULT_CONFIG, ...(data.data as Partial<GameConfig>) };
  console.log('Game config loaded:', JSON.stringify(currentConfig));
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function validateBundles(bundles: unknown): CardBundle[] {
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error('bundles must be a non-empty array');
  }
  return bundles.map((b, i) => {
    if (typeof b.id !== 'string' || !b.id) throw new Error(`bundle[${i}].id must be a non-empty string`);
    const cardCount = Math.round(Number(b.cardCount));
    const priceOren = Number(b.priceOren);
    if (!Number.isFinite(cardCount) || cardCount < 1 || cardCount > 20) {
      throw new Error(`bundle[${i}].cardCount must be between 1 and 20`);
    }
    if (!Number.isFinite(priceOren) || priceOren <= 0 || priceOren > 100000) {
      throw new Error(`bundle[${i}].priceOren must be a positive number`);
    }
    return {
      id: b.id,
      cardCount,
      priceOren,
      label: typeof b.label === 'string' && b.label ? b.label : `${cardCount} Card${cardCount === 1 ? '' : 's'}`,
    };
  });
}

function validateSoloMultipliers(multipliers: unknown, bundles: CardBundle[]): Record<string, number> {
  if (typeof multipliers !== 'object' || multipliers === null) {
    throw new Error('soloMultipliers must be an object');
  }
  const result: Record<string, number> = {};
  for (const bundle of bundles) {
    const raw = (multipliers as Record<string, unknown>)[bundle.id];
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 1000) {
      throw new Error(`soloMultipliers.${bundle.id} must be a positive number`);
    }
    result[bundle.id] = value;
  }
  return result;
}

/**
 * Validates and persists a partial config update, then updates the
 * in-memory copy immediately so it's visible right away — but only
 * rooms created after this point ever see it (see Room's config
 * snapshot fields in types.ts).
 */
export async function updateConfig(partial: Partial<GameConfig>): Promise<GameConfig> {
  const next: GameConfig = { ...currentConfig };

  if (partial.ballCap !== undefined) {
    const ballCap = Math.round(Number(partial.ballCap));
    if (!Number.isFinite(ballCap) || ballCap < 5 || ballCap > 75) {
      throw new Error('ballCap must be between 5 and 75');
    }
    next.ballCap = ballCap;
  }

  if (partial.rakePercent !== undefined) {
    const rakePercent = Number(partial.rakePercent);
    if (!Number.isFinite(rakePercent) || rakePercent < 0 || rakePercent > 0.9) {
      throw new Error('rakePercent must be between 0 and 0.9 (i.e. 0% to 90%)');
    }
    next.rakePercent = rakePercent;
  }

  if (partial.bundles !== undefined) {
    next.bundles = validateBundles(partial.bundles);
  }

  if (partial.soloMultipliers !== undefined) {
    next.soloMultipliers = validateSoloMultipliers(partial.soloMultipliers, next.bundles);
  } else if (partial.bundles !== undefined) {
    // Bundles changed but multipliers weren't explicitly sent — make
    // sure every bundle still has a multiplier, defaulting new ones.
    const merged: Record<string, number> = {};
    for (const bundle of next.bundles) {
      merged[bundle.id] = next.soloMultipliers[bundle.id] ?? 3.5;
    }
    next.soloMultipliers = merged;
  }

  if (partial.noxBonusDisplay !== undefined) {
    const noxBonusDisplay = Number(partial.noxBonusDisplay);
    if (!Number.isFinite(noxBonusDisplay) || noxBonusDisplay < 0 || noxBonusDisplay > 100000) {
      throw new Error('noxBonusDisplay must be a non-negative number');
    }
    next.noxBonusDisplay = noxBonusDisplay;
  }

  const { error } = await supabase
    .from('game_config')
    .upsert({ id: 1, data: next, updated_at: new Date().toISOString() });

  if (error) {
    throw new Error('Failed to save config: ' + error.message);
  }

  currentConfig = next;
  return currentConfig;
}