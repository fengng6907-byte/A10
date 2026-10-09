import type Database from 'better-sqlite3';
import { getAccessToken } from './moomoo-auth';
import { ProviderError } from './errors';
import { marketSession } from './session';
import { stockDb } from './store';
import { persistMoomooState } from './moomoo-persistence';
import type { DailyBar, DataFreshness, QuoteQuality, StockQuote } from './types';

const API_HOST = 'https://webapi.moomoo.com';
const QUOTE_PATH = '/api/v1.0/quote/stock-quote';
const SOURCE_URL = `${API_HOST}${QUOTE_PATH}`;
const asNumber = (value: unknown): number | null => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let nextRequestAt = 0;

type ApiEnvelope = { ret_code?: unknown; ret_msg?: unknown; code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown }; data?: Record<string, unknown> };
type QuoteRow = Record<string, unknown>;

export function moomooAccessClass(db?: Database.Database): QuoteQuality {
  if (process.env.MOOMOO_US_QUOTE_ACCESS === 'REALTIME') return 'REALTIME';
  if (process.env.MOOMOO_US_QUOTE_ACCESS === 'DELAYED') return 'DELAYED';
  if (db) {
    const entitlement = db.prepare("SELECT status FROM moomoo_entitlements WHERE id=1 AND market='US' AND capability='QUOTE_PUSH'").get() as { status: string } | undefined;
    if (entitlement?.status === 'CONFIRMED') return 'REALTIME';
  }
  return 'UNVERIFIED';
}

export function quoteFreshness(quality: QuoteQuality, quoteAt: string, now = new Date()): DataFreshness {
  const ageMinutes = (now.getTime() - Date.parse(quoteAt)) / 60_000;
  if (!Number.isFinite(ageMinutes) || ageMinutes < -5) return 'STALE';
  const session = marketSession(now).session;
  if (session === 'REGULAR' && ageMinutes > (quality === 'DELAYED' || quality === 'UNVERIFIED' ? 45 : 5)) return 'STALE';
  if (session !== 'REGULAR') return ageMinutes > 96 * 60 ? 'STALE' : 'MARKET_CLOSED';
  if (quality === 'REALTIME') return 'LIVE';
  return 'DELAYED';
}

export function parseMoomooQuotes(payload: ApiEnvelope, requested: string[], now = new Date(), declared: QuoteQuality = moomooAccessClass()): StockQuote[] {
  const retCode = Number(payload.ret_code ?? payload.code ?? 0);
  if (retCode !== 0) {
    const code = String(payload.error?.code ?? retCode);
    const detail = String(payload.ret_msg ?? payload.error?.message ?? payload.message ?? 'request failed');
    throw new ProviderError(`Moomoo ${code}: ${detail}`, /rate|timeout|internal|temporar/i.test(`${code} ${detail}`), code);
  }
  const rows = payload.data?.quote_list;
  if (!Array.isArray(rows)) throw new ProviderError('Moomoo quote response did not contain data.quote_list', false, 'invalid_response');
  const quotes = rows.map((item): StockQuote => {
    const row = item as QuoteRow;
    const code = String(row.code ?? '');
    const ticker = code.startsWith('US.') ? code.slice(3).toUpperCase() : code.toUpperCase();
    const price = asNumber(row.last_price), stamp = asNumber(row.data_time ?? row.update_time);
    if (!ticker || !price || price <= 0 || !stamp) throw new ProviderError(`Moomoo returned an incomplete quote for ${code || 'an unknown symbol'}`, false, 'invalid_response');
    const quoteAt = new Date(stamp).toISOString();
    const quality: QuoteQuality = quoteFreshness(declared, quoteAt, now) === 'STALE' ? 'STALE' : declared;
    return { ticker, companyName: typeof row.name === 'string' ? row.name : null, exchange: 'US', price,
      open: asNumber(row.open_price), high: asNumber(row.high_price), low: asNumber(row.low_price), previousClose: asNumber(row.prev_close_price),
      volume: asNumber(row.volume), averageVolume: null, week52High: null, week52Low: null, quoteAt, provider: 'MOOMOO', quality,
      freshness: quoteFreshness(quality, quoteAt, now), sourceUrl: SOURCE_URL };
  });
  const returned = new Set(quotes.map(x => x.ticker));
  const missing = requested.filter(x => !returned.has(x));
  if (missing.length) throw new ProviderError(`Moomoo did not return valid US symbols: ${missing.join(', ')}`, false, 'invalid_symbol');
  return quotes;
}

function recordHealth(db: Database.Database, input: { status: string; detail: string; latencyMs?: number; httpStatus?: number; providerTimestamp?: string }) {
  db.prepare('INSERT INTO moomoo_provider_health(checked_at,status,latency_ms,http_status,provider_timestamp,detail) VALUES(?,?,?,?,?,?)')
    .run(new Date().toISOString(), input.status, input.latencyMs ?? null, input.httpStatus ?? null, input.providerTimestamp ?? null, input.detail.slice(0, 500));
}

function validTicker(value: string) {
  const ticker = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) throw new ProviderError(`Invalid US ticker ${value}`, false, 'invalid_symbol');
  return ticker;
}

export class MoomooEquities {
  id = 'MOOMOO';
  constructor(private db: Database.Database = stockDb(), private fetchImpl: typeof fetch = fetch) {}

  private async throttle() {
    const perSecond = Math.max(1, Number(process.env.MOOMOO_API_PER_SECOND ?? 4));
    const wait = Math.max(0, nextRequestAt - Date.now());
    nextRequestAt = Math.max(Date.now(), nextRequestAt) + Math.ceil(1000 / perSecond);
    if (wait) await sleep(wait);
  }

  private async request(path: string, init: RequestInit = {}) {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.throttle();
      const started = Date.now(), controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const token = await getAccessToken(this.db, this.fetchImpl);
        const response = await this.fetchImpl(`${API_HOST}${path}`, { ...init, cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
        const payload = await response.json() as ApiEnvelope;
        if (response.ok && Number(payload.ret_code ?? payload.code ?? 0) === 0) {
          recordHealth(this.db, { status: 'CONNECTED', detail: 'Authenticated Moomoo REST request succeeded.', latencyMs: Date.now() - started, httpStatus: response.status });
          return payload;
        }
        const detail = String(payload.ret_msg ?? payload.error?.message ?? payload.message ?? `HTTP ${response.status}`);
        const code = String(payload.error?.code ?? payload.ret_code ?? payload.code ?? response.status);
        const retryable = response.status === 429 || response.status >= 500 || /rate|timeout|internal|temporar/i.test(`${code} ${detail}`);
        if (response.status === 401 && attempt === 0) this.db.prepare("UPDATE moomoo_oauth_tokens SET expires_at='1970-01-01T00:00:00.000Z' WHERE id=1").run();
        else if (!retryable) throw new ProviderError(`Moomoo ${code}: ${detail}`, false, code);
        last = new ProviderError(`Moomoo ${code}: ${detail}`, true, code);
      } catch (error) {
        last = error;
        if (error instanceof ProviderError && !error.retryable) {
          recordHealth(this.db, { status: 'DISCONNECTED', detail: error.message });
          throw error;
        }
      } finally { clearTimeout(timer); }
      if (attempt < 2) await sleep(250 * 2 ** attempt);
    }
    const error = last instanceof Error ? last : new Error('Moomoo request failed');
    recordHealth(this.db, { status: 'DISCONNECTED', detail: error.message });
    throw error instanceof ProviderError ? error : new ProviderError(error.message, true);
  }

  async getQuotes(tickers: string[]) {
    const symbols = [...new Set(tickers.map(validTicker))];
    if (!symbols.length) return [];
    const cacheKey = `quotes:${symbols.slice().sort().join(',')}`;
    const cached = this.db.prepare('SELECT payload_json AS payloadJson,expires_at AS expiresAt FROM moomoo_quote_cache WHERE cache_key=?').get(cacheKey) as { payloadJson: string; expiresAt: string } | undefined;
    if (cached && Date.parse(cached.expiresAt) > Date.now()) return parseMoomooQuotes(JSON.parse(cached.payloadJson) as ApiEnvelope, symbols, new Date(), moomooAccessClass(this.db));
    const payload = await this.request(QUOTE_PATH, { method: 'POST', body: JSON.stringify({ code_list: symbols.map(x => `US.${x}`) }) });
    const quotes = parseMoomooQuotes(payload, symbols, new Date(), moomooAccessClass(this.db));
    const ttl = Math.max(1, Number(process.env.MOOMOO_QUOTE_CACHE_SECONDS ?? 5));
    const now = new Date();
    this.db.prepare(`INSERT INTO moomoo_quote_cache(cache_key,payload_json,provider_timestamp,expires_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(cache_key) DO UPDATE SET payload_json=excluded.payload_json,provider_timestamp=excluded.provider_timestamp,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
      .run(cacheKey, JSON.stringify(payload), quotes.reduce((latest, x) => x.quoteAt > latest ? x.quoteAt : latest, ''), new Date(now.getTime() + ttl * 1000).toISOString(), now.toISOString());
    recordHealth(this.db, { status: 'CONNECTED', detail: `Authenticated quote batch succeeded for ${symbols.length} symbol(s).`, providerTimestamp: quotes.reduce((latest, x) => x.quoteAt > latest ? x.quoteAt : latest, '') });
    return quotes;
  }

  async getQuote(ticker: string) { return (await this.getQuotes([ticker]))[0]; }

  async diagnoseQuotes(tickers: string[]) {
    const symbols = [...new Set(tickers.map(validTicker))], requestedAt = new Date();
    const payload = await this.request(QUOTE_PATH, { method: 'POST', body: JSON.stringify({ code_list: symbols.map(x => `US.${x}`) }) });
    const receivedAt = new Date();
    const quotes = parseMoomooQuotes(payload, symbols, receivedAt, moomooAccessClass(this.db));
    const rows = Array.isArray(payload.data?.quote_list) ? payload.data.quote_list as QuoteRow[] : [];
    return { quotes, diagnostic: {
      endpoint: `${API_HOST}${QUOTE_PATH}`, method: 'POST', authentication: 'Bearer [REDACTED]', cache: 'BYPASSED_FOR_DIAGNOSTIC',
      requestedAt: requestedAt.toISOString(), receivedAt: receivedAt.toISOString(), singaporeReceivedAt: receivedAt.toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'full', timeStyle: 'long', hour12: false }),
      response: { ret_code: payload.ret_code ?? payload.code ?? null, ret_msg: payload.ret_msg ?? payload.message ?? null,
        quote_list: rows.map(row => ({ code: row.code, name: row.name, data_time: row.data_time, data_time_unit: 'UNIX_MILLISECONDS', data_date: row.data_date,
          last_price: row.last_price, open_price: row.open_price, high_price: row.high_price, low_price: row.low_price, prev_close_price: row.prev_close_price,
          volume: row.volume, sec_status: row.sec_status, suspension: row.suspension })) },
      timing: quotes.map(quote => ({ ticker: quote.ticker, sourceTimestamp: quote.quoteAt, receiptTimestamp: receivedAt.toISOString(), observedDelaySeconds: Number(((receivedAt.getTime() - Date.parse(quote.quoteAt)) / 1000).toFixed(3)) }))
    } };
  }

  async getDailyBars(ticker: string, limit: number): Promise<DailyBar[]> {
    const symbol = `US.${validTicker(ticker)}`, end = new Date().toISOString().slice(0, 10);
    const count = Math.max(1, Math.min(370, Math.floor(limit)));
    const query = new URLSearchParams({ end, ktype: '2', autype: '3', num: String(count) });
    const payload = await this.request(`/api/v1.0/quote/${encodeURIComponent(symbol)}/history-kline?${query}`);
    const rows = payload.data?.kline_list;
    if (!Array.isArray(rows)) throw new ProviderError(`Moomoo did not return historical candlesticks for ${ticker}`, false, 'invalid_response');
    return rows.map(item => {
      const row = item as QuoteRow, time = asNumber(row.time_key);
      const open = asNumber(row.open ?? row.open_price), high = asNumber(row.high ?? row.high_price), low = asNumber(row.low ?? row.low_price), close = asNumber(row.close ?? row.close_price);
      if (!time || open === null || high === null || low === null || close === null) throw new ProviderError(`Moomoo returned an invalid candlestick for ${ticker}`, false, 'invalid_response');
      return { date: new Date(time).toISOString().slice(0, 10), open, high, low, close, volume: asNumber(row.volume) };
    }).sort((a, b) => a.date.localeCompare(b.date));
  }

  marketStatus(now = new Date()) {
    const session = marketSession(now);
    return { market: 'US', session: session.session, provider: this.id, observedAt: now.toISOString(), source: 'NYSE calendar with Moomoo quote timestamps' };
  }
}

export async function testMoomooConnection(db: Database.Database = stockDb(), fetchImpl: typeof fetch = fetch) {
  const started = Date.now(), provider = new MoomooEquities(db, fetchImpl);
  try {
    const entitlement = await probeMoomooQuoteEntitlement(db);
    const { quotes, diagnostic } = await provider.diagnoseQuotes(['TSLA', 'MSFT']);
    return { ok: true, latencyMs: Date.now() - started, accessClass: moomooAccessClass(db), entitlement, diagnostic,
      quotes: quotes.map(x => ({ ticker: x.ticker, price: x.price, providerTimestamp: x.quoteAt, receiptTimestamp: diagnostic.receivedAt,
        observedDelaySeconds: diagnostic.timing.find(y => y.ticker === x.ticker)?.observedDelaySeconds ?? null, freshness: x.freshness, quality: x.quality })) };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : 'Unknown Moomoo connection error' };
  }
}

export async function probeMoomooQuoteEntitlement(db: Database.Database = stockDb(), timeoutMs = 10_000) {
  const checkedAt = new Date().toISOString();
  const save = (status: string, evidence: string) => {
    db.prepare(`INSERT INTO moomoo_entitlements(id,market,capability,status,level,checked_at,evidence) VALUES(1,'US','QUOTE_PUSH',?,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,level=excluded.level,checked_at=excluded.checked_at,evidence=excluded.evidence`).run(status, checkedAt, evidence.slice(0, 500));
    return { market: 'US', capability: 'REALTIME_BASIC_QUOTE_PUSH', status, level: null, checkedAt, evidence };
  };
  try {
    const token = await getAccessToken(db);
    return await new Promise<ReturnType<typeof save>>((resolve) => {
      const socket = new WebSocket('wss://webapi-quote.moomoo.com/ws');
      let settled = false, authenticated = false;
      const finish = (status: string, evidence: string) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); const result = save(status, evidence); void persistMoomooState(db).then(() => resolve(result), () => resolve(result)); };
      const timer = setTimeout(() => finish('UNVERIFIED', authenticated ? 'Authenticated, but the US quote subscription did not return a conclusive result before timeout.' : 'WebSocket authentication did not complete before timeout.'), timeoutMs);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 'entitlement-auth', action: 'auth', data: { auth_type: 'oauth2', authorization: `Bearer ${token}` } })));
      socket.addEventListener('message', event => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(String(event.data)) as Record<string, unknown>; } catch { return; }
        if (message.session_id) { authenticated = true; socket.send(JSON.stringify({ id: 'entitlement-subscribe', action: 'subscribe', quote: ['US.TSLA', 'US.MSFT'] })); return; }
        if (authenticated && message.type === 'QUOTE' && ['US.TSLA', 'US.MSFT'].includes(String(message.symbol ?? ''))) {
          finish('CONFIRMED', `Moomoo delivered an authenticated US basic quote push for ${String(message.symbol)}.`);
          return;
        }
        if (message.id === 'entitlement-subscribe' || (authenticated && Object.prototype.hasOwnProperty.call(message, 'code'))) {
          const code = Number(message.code ?? -1), detail = String(message.message ?? '');
          finish(code === 0 ? 'CONFIRMED' : 'DENIED', code === 0
            ? 'Moomoo accepted an authenticated WebSocket basic quote subscription for US.TSLA and US.MSFT.'
            : `Moomoo rejected the authenticated US quote subscription (code ${code}: ${detail || 'no detail'}).`);
        }
      });
      socket.addEventListener('error', () => finish('UNVERIFIED', 'Moomoo WebSocket entitlement probe failed; REST quotes remain available.'));
      socket.addEventListener('close', () => { if (!settled) finish('UNVERIFIED', 'Moomoo closed the entitlement probe before returning a subscription result.'); });
    });
  } catch (error) { const result = save('UNVERIFIED', error instanceof Error ? error.message : 'Unable to probe Moomoo quote entitlement.'); await persistMoomooState(db); return result; }
}
