import type { Candle, Quote, Timeframe } from './types';

export interface MarketDataProvider {
  getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  getQuote(symbol: string): Promise<Quote>;
}

const minutes: Record<Timeframe, number> = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
function mockCandles(timeframe: Timeframe, limit: number): Candle[] {
  const step = minutes[timeframe] * 60_000;
  const end = Date.UTC(2026, 8, 29, 8, 0);
  const mid = (hoursAgo: number) => 3350 - hoursAgo * 0.018 + Math.sin(hoursAgo * 0.31) * 4.2 + Math.sin(hoursAgo * 0.073) * 3.1;
  const range = timeframe === '4h' ? 2.6 : timeframe === '1h' ? 1.4 : timeframe === '1d' ? 5 : 0.8;
  return Array.from({ length: limit }, (_, i) => {
    const time = end - (limit - 1 - i) * step;
    const hoursAgo = (end - time) / 3_600_000;
    const close = mid(hoursAgo);
    const open = mid(hoursAgo + minutes[timeframe] / 60);
    return { time: new Date(time).toISOString(), open, close, high: Math.max(open, close) + range * (1 + 0.12 * Math.sin(time / step * 0.71)), low: Math.min(open, close) - range * (1 + 0.12 * Math.cos(time / step * 0.83)) };
  });
}

class MockProvider implements MarketDataProvider {
  async getCandles(_symbol: string, timeframe: Timeframe, limit: number) { return mockCandles(timeframe, limit); }
  async getQuote(symbol: string): Promise<Quote> {
    const price = mockCandles('15m', 160).at(-1)!.close;
    const previousClose = mockCandles('1d', 2)[0].close;
    return { price, previousClose, spread: 0.32, time: new Date(Date.UTC(2026, 8, 29, 8)).toISOString(), source: `Sample data · ${symbol}` };
  }
}

class TwelveDataProvider implements MarketDataProvider {
  private async request(params: Record<string, string>) {
    const url = new URL('https://api.twelvedata.com/' + (params.endpoint ?? 'time_series'));
    const { endpoint: _endpoint, ...query } = params;
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set('apikey', process.env.TWELVE_DATA_API_KEY!);
    const response = await fetch(url, { next: { revalidate: 60 } });
    if (!response.ok) throw new Error(`Market data HTTP ${response.status}`);
    const data = await response.json();
    if (data.status === 'error') throw new Error(data.message ?? 'Market data unavailable');
    return data;
  }
  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const interval = { '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day' }[timeframe];
    const data = await this.request({ symbol: symbol.replace('XAUUSD', 'XAU/USD'), interval, outputsize: String(limit), timezone: 'UTC' });
    if (!Array.isArray(data.values)) throw new Error('Invalid market candles');
    return data.values.map((v: Record<string, string>) => ({ time: new Date(v.datetime.replace(' ', 'T') + (v.datetime.includes('Z') ? '' : 'Z')).toISOString(), open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close) })).reverse();
  }
  async getQuote(symbol: string): Promise<Quote> {
    const candles = await this.getCandles(symbol, '15m', 2);
    const daily = await this.getCandles(symbol, '1d', 2);
    return { price: candles.at(-1)!.close, previousClose: daily.at(-2)?.close ?? candles[0].close, spread: null, time: candles.at(-1)!.time, source: 'Twelve Data · live API' };
  }
}

export function marketProvider(): MarketDataProvider {
  return process.env.MARKET_DATA_MODE === 'live' && process.env.TWELVE_DATA_API_KEY ? new TwelveDataProvider() : new MockProvider();
}
