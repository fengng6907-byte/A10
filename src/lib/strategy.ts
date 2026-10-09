import { atr, ema, structure, swings } from './indicators';
import { marketProvider } from './market';
import { positionSize, riskLimits } from './risk';
import type { Analysis, Bias, Candle, ChecklistItem, Settings, Trade } from './types';

const r = (n: number | null, digits = 2) => n === null ? null : Number(n.toFixed(digits));
function previousDay(candles: Candle[]) {
  const latest = candles.at(-1)!.time.slice(0, 10);
  const days = [...new Set(candles.map(c => c.time.slice(0, 10)).filter(day => day < latest))];
  const day = days.at(-1);
  const subset = candles.filter(c => c.time.slice(0, 10) === day);
  return { high: subset.length ? Math.max(...subset.map(c => c.high)) : null, low: subset.length ? Math.min(...subset.map(c => c.low)) : null };
}

export async function calculateDashboard(settings: Settings, trades: Trade[]) {
  const provider = marketProvider();
  const [four, one, fifteen, quote] = await Promise.all([
    provider.getCandles('XAUUSD', '4h', 240), provider.getCandles('XAUUSD', '1h', 160),
    provider.getCandles('XAUUSD', '15m', 160), provider.getQuote('XAUUSD')
  ]);
  if (four.length < 201 || one.length < 20 || fifteen.length < 30) throw new Error('Not enough market candles to evaluate strategy');
  const ema50 = ema(four.map(c => c.close), 50)!;
  const ema200 = ema(four.map(c => c.close), 200)!;
  const fourStructure = structure(four), oneStructure = structure(one);
  const gap = Math.abs(ema50 - ema200) / ema200;
  const trend: Bias = gap < 0.001 || fourStructure.bias === 'NEUTRAL' ? 'NEUTRAL' :
    ema50 > ema200 && fourStructure.bias === 'BULLISH' ? 'BULLISH' :
    ema50 < ema200 && fourStructure.bias === 'BEARISH' ? 'BEARISH' : 'NEUTRAL';
  const oneSwings = swings(one), fifteenSwings = swings(fifteen);
  const current = fifteen.at(-1)!;
  const currentAtr = atr(fifteen)!;
  const atrHistory = Array.from({ length: 20 }, (_, i) => atr(fifteen.slice(0, fifteen.length - i))).filter((v): v is number => v !== null);
  const avgAtr = atrHistory.reduce((a, b) => a + b, 0) / atrHistory.length;
  const atrRatio = currentAtr / avgAtr;
  const volatility = atrRatio < 0.75 ? 'LOW' : atrRatio < 1.35 ? 'NORMAL' : atrRatio < 1.8 ? 'HIGH' : 'EXTREME';
  const support = oneSwings.lows.at(-1)?.price ?? null;
  const resistance = oneSwings.highs.at(-1)?.price ?? null;
  const swingHigh = oneSwings.highs.at(-1)?.price ?? null;
  const swingLow = oneSwings.lows.at(-1)?.price ?? null;
  const priorHigh = oneSwings.highs.at(-2)?.price ?? null, priorLow = oneSwings.lows.at(-2)?.price ?? null;
  const latestOneClose = one.at(-1)!.close;
  const breakoutRetest = priorHigh !== null && latestOneClose > priorHigh ? priorHigh : priorLow !== null && latestOneClose < priorLow ? priorLow : null;
  const day = previousDay(one);
  const directionAligned = trend !== 'NEUTRAL' && oneStructure.bias === trend;
  const reference = trend === 'BULLISH' ? support : trend === 'BEARISH' ? resistance : null;
  const atLocation = reference !== null && Math.abs(current.close - reference) <= Math.max(currentAtr * 1.5, 4);
  const recent15High = fifteenSwings.highs.at(-1)?.price ?? null;
  const recent15Low = fifteenSwings.lows.at(-1)?.price ?? null;
  const previous = fifteen.at(-2)!;
  const bullishRejection = current.close > current.open && current.close > previous.close && current.low < previous.low;
  const bearishRejection = current.close < current.open && current.close < previous.close && current.high > previous.high;
  const confirmed = atLocation && (trend === 'BULLISH' ? bullishRejection && recent15High !== null && current.close > recent15High : trend === 'BEARISH' ? bearishRejection && recent15Low !== null && current.close < recent15Low : false);
  const invalidated = trend === 'BULLISH' ? swingLow !== null && current.close < swingLow : trend === 'BEARISH' ? swingHigh !== null && current.close > swingHigh : false;
  const entryState = invalidated ? 'INVALIDATED' : confirmed ? 'CONFIRMED' : atLocation ? 'WAITING CONFIRMATION' : 'WATCHING';
  const stop = trend === 'BULLISH' ? swingLow : trend === 'BEARISH' ? swingHigh : null;
  const entry = current.close;
  const targetCandidates = trend === 'BULLISH' ? [resistance, day.high].filter((v): v is number => v !== null && v > entry) :
    trend === 'BEARISH' ? [support, day.low].filter((v): v is number => v !== null && v < entry) : [];
  const target = targetCandidates.length ? trend === 'BULLISH' ? Math.min(...targetCandidates) : Math.max(...targetCandidates) : null;
  const position = stop !== null && target !== null ? positionSize(settings, entry, stop, target, currentAtr) : null;
  const limits = riskLimits(settings, trades);
  const riskReady = limits.allowed && !!position && position.blockingReasons.length === 0 && position.riskUSD <= limits.dailyRiskRemaining;
  const checklist: ChecklistItem[] = [
    { label: '4H trend aligned', state: trend === 'NEUTRAL' ? 'failed' : 'passed' },
    { label: '1H structure aligned', state: directionAligned ? 'passed' : 'failed' },
    { label: 'At valid pullback area', state: atLocation ? 'passed' : 'waiting' },
    { label: '15M confirmation', state: confirmed ? 'passed' : invalidated ? 'failed' : 'waiting' },
    { label: 'ATR acceptable', state: volatility === 'EXTREME' ? 'failed' : 'passed' },
    { label: `Reward:risk ≥ ${settings.minRewardRisk.toFixed(1)}`, state: position?.rewardRisk && position.rewardRisk >= settings.minRewardRisk ? 'passed' : 'failed' },
    { label: 'Risk limit available', state: riskReady ? 'passed' : 'failed' },
    { label: 'Daily trade limit available', state: limits.tradesRemaining > 0 ? 'passed' : 'failed' }
  ];
  const blockingReasons = [
    ...limits.reasons, ...(trend === 'NEUTRAL' ? ['4H trend is neutral'] : []),
    ...(!directionAligned ? ['1H structure does not align with 4H'] : []),
    ...(volatility === 'EXTREME' ? ['Extreme 15M volatility'] : []),
    ...(target === null && trend !== 'NEUTRAL' ? ['No valid structural profit target'] : []),
    ...(position?.blockingReasons ?? []),
    ...(position && position.riskUSD > limits.dailyRiskRemaining ? ['Planned risk exceeds daily risk remaining'] : [])
  ];
  const decision = blockingReasons.length ? 'NO_TRADE' : confirmed ? trend === 'BULLISH' ? 'BUY_SETUP' : 'SELL_SETUP' : 'WAIT';
  const passed = checklist.filter(c => c.state === 'passed').length;
  const confidence = passed >= 7 ? 'HIGH' : passed >= 4 ? 'MEDIUM' : 'LOW';
  const whatToWaitFor = trend === 'NEUTRAL' ? 'Wait for 4H EMA and swing structure to agree.' :
    !directionAligned ? 'Wait for 1H swing structure to align with the 4H trend.' :
    target === null ? 'Wait for a clear structural profit target beyond the entry.' :
    position && position.blockingReasons.length ? `Review the risk block: ${position.blockingReasons[0]}.` :
    !atLocation ? `Wait for price to revisit the 1H ${trend === 'BULLISH' ? 'support' : 'resistance'} area.` :
    !confirmed ? `Wait for a ${trend === 'BULLISH' ? 'bullish close above the recent 15M swing high' : 'bearish close below the recent 15M swing low'}.` :
    'Review the plan and decide whether it fits your own judgment.';
  const reasoningSummary = `4H trend is ${trend.toLowerCase()} and 1H structure is ${oneStructure.bias.toLowerCase()}. ${atLocation ? 'Price is at the 1H pullback area.' : 'Price is away from the 1H pullback area.'} 15M confirmation is ${confirmed ? 'present' : 'not present'}. ${blockingReasons.length ? blockingReasons[0] + '.' : whatToWaitFor}`;
  const analysis: Analysis = {
    symbol: 'XAUUSD', timestamp: quote.time, bias: trend, setupType: atLocation ? 'PULLBACK' : 'NONE', decision, confidence,
    fourHourTrend: `${trend} · ${fourStructure.label}`, oneHourStructure: `${oneStructure.bias} · ${oneStructure.label}`,
    fifteenMinuteConfirmation: `${entryState} · ${confirmed ? 'rejection and swing break' : 'no confirmed swing break'}`,
    entryZone: { low: reference === null ? null : r(reference - currentAtr * 0.5), high: reference === null ? null : r(reference + currentAtr * 0.5) },
    invalidationPrice: r(stop), stopLoss: r(stop), takeProfit: r(target), rewardRisk: position?.rewardRisk ?? null,
    riskUSD: position?.riskUSD ?? null, positionSize: position?.lots ?? null, newsRisk: 'UNKNOWN',
    tradeAllowed: decision === 'BUY_SETUP' || decision === 'SELL_SETUP', blockingReasons, reasoningSummary, whatToWaitFor
  };
  return { analysis, quote, fourHour: { ema50: r(ema50), ema200: r(ema200), structure: fourStructure, trend },
    oneHour: { structure: oneStructure, support: r(support), resistance: r(resistance), swingHigh: r(swingHigh), swingLow: r(swingLow), breakoutRetest: r(breakoutRetest), previousDayHigh: r(day.high), previousDayLow: r(day.low) },
    fifteenMinute: { entryState, recentSwingHigh: r(recent15High), recentSwingLow: r(recent15Low), atr: r(currentAtr), averageAtr: r(avgAtr), volatility },
    limits, position, checklist, conditionsMet: passed, candles: fifteen.slice(-72), settings, trades };
}
