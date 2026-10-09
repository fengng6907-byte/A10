export type Timeframe = '15m' | '1h' | '4h' | '1d';
export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type Decision = 'BUY_SETUP' | 'SELL_SETUP' | 'WAIT' | 'NO_TRADE';
export type EntryState = 'WATCHING' | 'WAITING CONFIRMATION' | 'CONFIRMED' | 'INVALIDATED';
export type Candle = { time: string; open: number; high: number; low: number; close: number; volume?: number };
export type Quote = { price: number; previousClose: number; spread: number | null; time: string; source: string };
export type Settings = { balance: number; riskPercent: number; contractSize: number; minLot: number; lotStep: number; maxLeverage: number; maxTradesPerDay: number; maxDailyLossPercent: number; maxWeeklyDrawdownPercent: number; minRewardRisk: number };
export type Trade = { id: number; openedAt: string; side: 'BUY' | 'SELL'; entry: number; stop: number; target: number; lots: number; plannedRisk: number; realizedPnl: number | null; status: 'PLANNED' | 'CLOSED'; notes: string };
export type ChecklistItem = { label: string; state: 'passed' | 'waiting' | 'failed' };
export type Analysis = {
  symbol: 'XAUUSD'; timestamp: string; bias: Bias; setupType: 'PULLBACK' | 'RETEST' | 'NONE'; decision: Decision;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH'; fourHourTrend: string; oneHourStructure: string; fifteenMinuteConfirmation: string;
  entryZone: { low: number | null; high: number | null }; invalidationPrice: number | null; stopLoss: number | null;
  takeProfit: number | null; rewardRisk: number | null; riskUSD: number | null; positionSize: number | null;
  newsRisk: 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH'; tradeAllowed: boolean; blockingReasons: string[];
  reasoningSummary: string; whatToWaitFor: string;
};
