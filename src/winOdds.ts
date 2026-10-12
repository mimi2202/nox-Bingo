import { CardBundle } from './types';

/**
 * Win odds for a SOLO game, measured by simulating the real GameEngine
 * (5x5 card, free centre, rows and columns only, 75 balls) 3,000,000
 * times. Index = number of balls drawn, value = chance ONE card has
 * bingo by then. Re-run the simulation if GameEngine's rules change.
 */
const SINGLE_CARD_CHANCE_BY_BALLS: number[] = [
  0, 0, 0, 0, 0, 1e-05, 3e-05, 7e-05, 0.00015, 0.00027,
  0.00048, 0.00077, 0.00121, 0.0018, 0.00262, 0.00366, 0.00504, 0.00681, 0.00898, 0.01165,
  0.01501, 0.01905, 0.0239, 0.02972, 0.03656, 0.04448, 0.05366, 0.06422, 0.0762, 0.08978,
  0.10502, 0.12197, 0.14107, 0.16199, 0.185, 0.20999, 0.23692, 0.26596, 0.29698, 0.32984,
  0.36436, 0.40046, 0.43765, 0.47586, 0.51509, 0.5547, 0.59445, 0.63388, 0.67227, 0.70998,
  0.74614, 0.78077, 0.81302, 0.84281, 0.86993, 0.89444, 0.91593, 0.93456, 0.95039, 0.96347,
  0.97387, 0.98215, 0.98833, 0.99277, 0.99575, 0.99774, 0.99893, 0.99956, 0.99985, 0.99996,
  0.99999, 1, 1, 1, 1, 1,
];

/**
 * Chance that at least one of `cardCount` cards wins within `ballCap`
 * balls. Treats the cards as independent, which slightly OVERSTATES the
 * true chance (by under 1 percentage point) — so any safety check built
 * on it errs on the side of caution.
 */
export function winProbability(cardCount: number, ballCap: number): number {
  const cap = Math.max(0, Math.min(75, Math.floor(ballCap)));
  const p1 = SINGLE_CARD_CHANCE_BY_BALLS[cap] ?? 1;
  return 1 - Math.pow(1 - p1, Math.max(1, cardCount));
}

interface SoloCheckConfig {
  ballCap: number;
  bundles: CardBundle[];
  soloMultipliers: Record<string, number>;
}

/**
 * Returns a human-readable problem for every bundle whose solo payout
 * would, on average, return more than `maxReturn` (e.g. 0.95 = 95%) of
 * what the player staked. A return above 100% means the treasury loses
 * money on average every time someone plays solo.
 */
export function soloReturnProblems(cfg: SoloCheckConfig, maxReturn: number): string[] {
  const problems: string[] = [];
  for (const b of cfg.bundles) {
    const mult = cfg.soloMultipliers[b.id];
    if (typeof mult !== 'number' || !Number.isFinite(mult)) continue;
    const winChance = winProbability(b.cardCount, cfg.ballCap);
    const returnRate = winChance * mult;
    if (returnRate > maxReturn) {
      problems.push(
        `"${b.label || b.id}": ${(winChance * 100).toFixed(1)}% win chance x ${mult} payout = ` +
          `${(returnRate * 100).toFixed(0)}% average return to the player (limit ${(maxReturn * 100).toFixed(0)}%). ` +
          `Lower the multiplier or the ball cap.`
      );
    }
  }
  return problems;
}