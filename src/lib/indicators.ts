import type { Candle } from './types';

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const weight = 2 / (period + 1);
  for (const price of values.slice(period)) value = price * weight + value * (1 - weight);
  return value;
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const ranges = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)));
  let value = ranges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const range of ranges.slice(period)) value = ((period - 1) * value + range) / period;
  return value;
}

export type Swing = { index: number; price: number };
export function swings(candles: Candle[], radius = 2): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [], lows: Swing[] = [];
  for (let i = radius; i < candles.length - radius; i++) {
    const around = candles.slice(i - radius, i + radius + 1);
    if (around.every((c, j) => j === radius || candles[i].high > c.high)) highs.push({ index: i, price: candles[i].high });
    if (around.every((c, j) => j === radius || candles[i].low < c.low)) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

export function structure(candles: Candle[]): { bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; label: string; high: number | null; low: number | null } {
  const { highs, lows } = swings(candles);
  const h = highs.slice(-3), l = lows.slice(-3);
  const high = h.at(-1)?.price ?? null, low = l.at(-1)?.price ?? null;
  if (h.length < 3 || l.length < 3) return { bias: 'NEUTRAL', label: 'Insufficient clear swings', high, low };
  if (h[2].price > h[1].price && h[1].price > h[0].price && l[2].price > l[1].price && l[1].price > l[0].price)
    return { bias: 'BULLISH', label: 'Higher highs / higher lows', high, low };
  if (h[2].price < h[1].price && h[1].price < h[0].price && l[2].price < l[1].price && l[1].price < l[0].price)
    return { bias: 'BEARISH', label: 'Lower highs / lower lows', high, low };
  return { bias: 'NEUTRAL', label: 'Mixed swing structure', high, low };
}
