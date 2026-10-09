import type { DailyBar, QuoteQuality, StockQuote } from './types';
import { marketSession } from './session';
import { MoomooEquities } from './moomoo';
import { ProviderError } from './errors';

export { ProviderError } from './errors';
export interface EquityDataProvider { id: string; getQuote(ticker: string): Promise<StockQuote>; getQuotes?(tickers: string[]): Promise<StockQuote[]>; getDailyBars(ticker: string, limit: number): Promise<DailyBar[]> }
const num = (x: unknown): number | null => x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null;
export function classifyQuality(declared: QuoteQuality, quoteAt: string, now = new Date()): QuoteQuality {
  if (declared === 'SAMPLE') return 'SAMPLE';
  const ageMinutes = (now.getTime() - Date.parse(quoteAt)) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < -5) return 'STALE';
  const marketOpen = marketSession(now).session === 'REGULAR';
  const maxAge = declared === 'EOD' ? 36 * 60 : declared === 'DELAYED' ? 45 : 20;
  return marketOpen && ageMinutes > maxAge ? 'STALE' : declared;
}
class TwelveDataEquities implements EquityDataProvider {
  id = 'TWELVE_DATA';
  private async request(path: string, parameters: Record<string, string>) {
    const key = process.env.TWELVE_DATA_API_KEY;
    if (!key) throw new ProviderError('TWELVE_DATA_API_KEY is missing', false);
    const url = new URL(`https://api.twelvedata.com/${path}`);
    for (const [k, v] of Object.entries(parameters)) url.searchParams.set(k, v);
    url.searchParams.set('apikey', key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new ProviderError(`Twelve Data HTTP ${response.status}`, response.status === 429 || response.status >= 500);
      const data = await response.json();
      if (data.status === 'error') throw new ProviderError(`Twelve Data: ${data.message ?? 'request failed'}`, data.code === 429);
      return data;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(error instanceof Error ? error.message : 'Provider request failed');
    } finally { clearTimeout(timer); }
  }
  async getQuote(ticker: string): Promise<StockQuote> {
    const data = await this.request('quote', { symbol: ticker });
    const price = num(data.close), stamp = num(data.last_quote_at) ?? num(data.timestamp);
    if (!price || price <= 0 || !stamp) throw new ProviderError(`Incomplete quote for ${ticker}`, false);
    const quoteAt = new Date(stamp * 1000).toISOString();
    const declared = (['REALTIME', 'DELAYED', 'EOD'] as const).find(x => x === process.env.STOCK_QUOTE_ACCESS) ?? 'UNVERIFIED';
    return { ticker, companyName: typeof data.name === 'string' ? data.name : null, exchange: typeof data.exchange === 'string' ? data.exchange : null,
      price, open: num(data.open), high: num(data.high), low: num(data.low), previousClose: num(data.previous_close),
      volume: num(data.volume), averageVolume: num(data.average_volume), week52High: num(data.fifty_two_week?.high), week52Low: num(data.fifty_two_week?.low),
      quoteAt, provider: this.id, quality: classifyQuality(declared, quoteAt), sourceUrl: `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(ticker)}` };
  }
  async getDailyBars(ticker: string, limit: number): Promise<DailyBar[]> {
    const data = await this.request('time_series', { symbol: ticker, interval: '1day', outputsize: String(limit) });
    if (!Array.isArray(data.values)) throw new ProviderError(`Missing daily bars for ${ticker}`, false);
    return data.values.map((v: Record<string, string>) => ({ date: v.datetime.slice(0, 10), open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close), volume: num(v.volume) })).reverse();
  }
}
class SampleEquities implements EquityDataProvider {
  id = 'SAMPLE';
  async getQuote(ticker: string): Promise<StockQuote> {
    const seed = [...ticker].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const price = Number((25 + seed * 0.63).toFixed(2));
    return { ticker, companyName: null, exchange: null, price, open: price * 1.005, high: price * 1.014, low: price * .989,
      previousClose: price * 1.01, volume: 850_000 + seed * 97, averageVolume: 1_000_000 + seed * 83,
      week52High: price * 1.45, week52Low: price * .66, quoteAt: '2026-09-29T20:00:00.000Z', provider: this.id, quality: 'SAMPLE', sourceUrl: '' };
  }
  async getDailyBars(ticker: string, limit: number): Promise<DailyBar[]> {
    const q = await this.getQuote(ticker);
    return Array.from({ length: limit }, (_, i) => { const date = new Date(Date.UTC(2026, 8, 29 - (limit - i))).toISOString().slice(0, 10); const close = q.price * (1 + Math.sin(i * .19) * .025); return { date, open: close * .995, high: close * 1.01, low: close * .99, close, volume: 1_000_000 }; });
  }
}
class FallbackEquities implements EquityDataProvider {
  id: string;
  constructor(private primary: EquityDataProvider, private fallback: EquityDataProvider) { this.id = `${primary.id}+${fallback.id}`; }
  async getQuote(ticker: string) { try { return await this.primary.getQuote(ticker); } catch { return this.fallback.getQuote(ticker); } }
  async getQuotes(tickers: string[]) {
    try { return this.primary.getQuotes ? await this.primary.getQuotes(tickers) : await Promise.all(tickers.map(x => this.primary.getQuote(x))); }
    catch { return this.fallback.getQuotes ? this.fallback.getQuotes(tickers) : Promise.all(tickers.map(x => this.fallback.getQuote(x))); }
  }
  async getDailyBars(ticker: string, limit: number) { try { return await this.primary.getDailyBars(ticker, limit); } catch { return this.fallback.getDailyBars(ticker, limit); } }
}
export function providerConfiguration() {
  const selected = process.env.STOCK_DATA_PROVIDER?.toLowerCase() || (process.env.STOCK_DATA_MODE === 'live' ? 'twelvedata' : 'sample');
  const fallback = process.env.STOCK_FALLBACK_PROVIDER?.toLowerCase() ?? 'none';
  return { selected, fallback };
}
export function equityProvider(): EquityDataProvider {
  const { selected, fallback } = providerConfiguration();
  const primary: EquityDataProvider = selected === 'moomoo' ? new MoomooEquities() : selected === 'twelvedata' ? new TwelveDataEquities() : new SampleEquities();
  if (fallback === 'twelvedata' && selected !== 'twelvedata') return new FallbackEquities(primary, new TwelveDataEquities());
  if (fallback === 'sample' && selected !== 'sample') return new FallbackEquities(primary, new SampleEquities());
  return primary;
}
