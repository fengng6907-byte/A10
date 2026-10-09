export const starterTickers = ['MSFT', 'GOOGL', 'V', 'AVGO', 'JNJ', 'PG', 'ALAB', 'RKLB', 'PLTR'] as const;
export const starterNames: Record<(typeof starterTickers)[number], string> = {
  MSFT: 'Microsoft Corporation', GOOGL: 'Alphabet Inc.', V: 'Visa Inc.', AVGO: 'Broadcom Inc.',
  JNJ: 'Johnson & Johnson', PG: 'The Procter & Gamble Company', ALAB: 'Astera Labs, Inc.',
  RKLB: 'Rocket Lab USA, Inc.', PLTR: 'Palantir Technologies Inc.'
};
export type QuoteQuality = 'SAMPLE' | 'REALTIME' | 'DELAYED' | 'EOD' | 'UNVERIFIED' | 'STALE';
export type DataFreshness = 'LIVE' | 'DELAYED' | 'MARKET_CLOSED' | 'STALE' | 'DISCONNECTED';
export type StockQuote = {
  ticker: string; companyName: string | null; exchange: string | null; price: number; open: number | null;
  high: number | null; low: number | null; previousClose: number | null; volume: number | null;
  averageVolume: number | null; week52High: number | null; week52Low: number | null;
  quoteAt: string; provider: string; quality: QuoteQuality; freshness?: DataFreshness; sourceUrl: string;
};
export type DailyBar = { date: string; open: number; high: number; low: number; close: number; volume: number | null };
export type AlertKind = 'PRICE_BELOW' | 'PRICE_ABOVE' | 'PERCENT_DROP' | 'PERCENT_INCREASE' | 'WEEK_52_HIGH' | 'WEEK_52_LOW' | 'UNUSUAL_VOLUME' | 'GAP_OPEN' | 'VALUATION_RANGE';
export type AlertRule = {
  id: number; companyId: number; ticker: string; kind: AlertKind; threshold: number | null; referencePrice: number | null;
  lowerBound: number | null; upperBound: number | null; volumeMultiple: number | null;
  cooldownMinutes: number; rearmPercent: number; active: boolean; armed: boolean;
  lastTriggeredAt: string | null; createdAt: string; updatedAt: string;
};
export type AlertEvent = { id: number; ticker: string; ruleId: number; kind: AlertKind; message: string; price: number; quoteAt: string; provider: string; quality: QuoteQuality; session: string; generatedAt: string; sourceUrl: string };
export type JobKind = 'WATCHLIST_QUOTES';
export type AgentJob = { id: number; kind: JobKind; dedupeKey: string; payloadJson: string; nextRunAt: string; cadenceSeconds: number | null; status: 'PENDING' | 'RUNNING' | 'RETRY' | 'DONE' | 'FAILED'; attempts: number; maxAttempts: number; lockOwner: string | null; lockedUntil: string | null; lastError: string | null };
