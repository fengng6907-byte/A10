import type { Settings, Trade } from './types';

export type Position = { riskUSD: number; stopDistance: number; rawLots: number; lots: number; actualRiskUSD: number; notional: number; effectiveLeverage: number; margin: number; rewardRisk: number; warnings: string[]; blockingReasons: string[] };
const round = (n: number, digits = 2) => Number(n.toFixed(digits));
export function positionSize(settings: Settings, entry: number, stop: number, target: number, atr?: number | null): Position {
  const riskUSD = settings.balance * settings.riskPercent / 100;
  const stopDistance = Math.abs(entry - stop);
  const rewardDistance = Math.abs(target - entry);
  const isBuy = stop < entry && target > entry;
  const isSell = stop > entry && target < entry;
  const blockingReasons: string[] = [], warnings: string[] = [];
  if (![entry, stop, target].every(Number.isFinite) || entry <= 0 || stop <= 0 || target <= 0 || stopDistance <= 0 || (!isBuy && !isSell)) blockingReasons.push('Invalid entry, stop or target geometry');
  const rawLots = stopDistance > 0 ? riskUSD / stopDistance / settings.contractSize : 0;
  const steps = Math.floor((rawLots + 1e-10) / settings.lotStep);
  const lots = round(steps * settings.lotStep, 8);
  const actualRiskUSD = lots * settings.contractSize * stopDistance;
  const notional = lots * settings.contractSize * entry;
  const effectiveLeverage = settings.balance > 0 ? notional / settings.balance : Infinity;
  const margin = notional / settings.maxLeverage;
  const rewardRisk = stopDistance > 0 ? rewardDistance / stopDistance : 0;
  if (lots < settings.minLot) blockingReasons.push(`Calculated lot ${lots.toFixed(2)} is below broker minimum ${settings.minLot.toFixed(2)}`);
  if (actualRiskUSD > riskUSD + 0.001) blockingReasons.push('Rounded position exceeds planned risk');
  if (rewardRisk < settings.minRewardRisk) blockingReasons.push('INSUFFICIENT REWARD:RISK');
  if (effectiveLeverage > settings.maxLeverage) blockingReasons.push('Position exceeds maximum available leverage');
  if (margin > settings.balance) blockingReasons.push('Estimated margin exceeds account equity');
  if (atr && stopDistance < atr * 0.75) blockingReasons.push('Stop is too tight relative to 15M ATR');
  else if (atr && stopDistance < atr) warnings.push('Stop is close to one 15M ATR');
  if (effectiveLeverage > 5) warnings.push('Effective leverage is high');
  return { riskUSD: round(riskUSD), stopDistance: round(stopDistance), rawLots: round(rawLots, 5), lots, actualRiskUSD: round(actualRiskUSD), notional: round(notional), effectiveLeverage: round(effectiveLeverage), margin: round(margin), rewardRisk: round(rewardRisk), warnings, blockingReasons };
}

export function riskLimits(settings: Settings, trades: Trade[], now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const weekday = (now.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - weekday)).toISOString().slice(0, 10);
  const today = trades.filter(t => t.openedAt.slice(0, 10) === day);
  const week = trades.filter(t => t.openedAt.slice(0, 10) >= monday);
  const dailyPnl = today.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
  const weeklyPnl = week.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
  const openPlannedRisk = today.filter(t => t.status === 'PLANNED').reduce((sum, t) => sum + t.plannedRisk, 0);
  const dailyLossLimit = settings.balance * settings.maxDailyLossPercent / 100;
  const weeklyLossLimit = settings.balance * settings.maxWeeklyDrawdownPercent / 100;
  const reasons: string[] = [];
  if (today.length >= settings.maxTradesPerDay) reasons.push('Maximum trades per day reached');
  if (dailyPnl <= -dailyLossLimit) reasons.push('Daily loss limit reached');
  if (weeklyPnl <= -weeklyLossLimit) reasons.push('Weekly drawdown limit reached');
  const dailyRiskRemaining = Math.max(0, dailyLossLimit + Math.min(0, dailyPnl) - openPlannedRisk);
  if (dailyRiskRemaining <= 0 && !reasons.includes('Daily loss limit reached')) reasons.push('Daily planned risk budget exhausted');
  return { allowed: reasons.length === 0, reasons, dailyPnl: round(dailyPnl), weeklyPnl: round(weeklyPnl), dailyLossLimit: round(dailyLossLimit), weeklyLossLimit: round(weeklyLossLimit), openPlannedRisk: round(openPlannedRisk), tradesToday: today.length, tradesRemaining: Math.max(0, settings.maxTradesPerDay - today.length), dailyRiskRemaining: round(dailyRiskRemaining) };
}
