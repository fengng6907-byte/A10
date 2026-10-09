import type Database from 'better-sqlite3';
import { getDatabase } from '@/lib/db';
import { starterTickers, starterNames, type AgentJob, type AlertEvent, type AlertKind, type AlertRule, type StockQuote } from './types';

export function ensureStockSchema(db: Database.Database) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_companies (
      id INTEGER PRIMARY KEY, ticker TEXT NOT NULL UNIQUE, name TEXT NOT NULL, sector TEXT,
      exchange TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stock_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stock_ticker_history (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id), ticker TEXT NOT NULL,
      valid_from TEXT NOT NULL, valid_to TEXT, event_type TEXT NOT NULL DEFAULT 'LISTING');
    CREATE TABLE IF NOT EXISTS stock_watchlist (
      company_id INTEGER PRIMARY KEY REFERENCES stock_companies(id), reference_price REAL,
      date_added TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS stock_quotes (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id),
      price REAL NOT NULL, open REAL, high REAL, low REAL, previous_close REAL, volume REAL,
      average_volume REAL, week52_high REAL, week52_low REAL, quote_at TEXT NOT NULL,
      collected_at TEXT NOT NULL, provider TEXT NOT NULL, quality TEXT NOT NULL, source_url TEXT NOT NULL,
      UNIQUE(company_id, quote_at, provider));
    CREATE INDEX IF NOT EXISTS idx_stock_quotes_company_time ON stock_quotes(company_id, quote_at DESC);
    CREATE TABLE IF NOT EXISTS stock_daily_bars (
      company_id INTEGER NOT NULL REFERENCES stock_companies(id), date TEXT NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL,
      provider TEXT NOT NULL, collected_at TEXT NOT NULL, PRIMARY KEY(company_id, date, provider));
    CREATE TABLE IF NOT EXISTS stock_alert_rules (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id), kind TEXT NOT NULL,
      threshold REAL, reference_price REAL, lower_bound REAL, upper_bound REAL, volume_multiple REAL,
      cooldown_minutes INTEGER NOT NULL DEFAULT 60, rearm_percent REAL NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1, armed INTEGER NOT NULL DEFAULT 1,
      last_triggered_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_stock_alert_rules_company ON stock_alert_rules(company_id, active);
    CREATE TABLE IF NOT EXISTS stock_alert_events (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id),
      rule_id INTEGER NOT NULL REFERENCES stock_alert_rules(id), fingerprint TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, message TEXT NOT NULL, price REAL NOT NULL, quote_at TEXT NOT NULL,
      provider TEXT NOT NULL, quality TEXT NOT NULL, session TEXT NOT NULL, generated_at TEXT NOT NULL,
      source_url TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_stock_alert_events_time ON stock_alert_events(generated_at DESC);
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL DEFAULT '{}', next_run_at TEXT NOT NULL, cadence_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5, lock_owner TEXT, locked_until TEXT,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_due ON agent_jobs(status, next_run_at);
    CREATE TABLE IF NOT EXISTS agent_job_runs (
      id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES agent_jobs(id), started_at TEXT NOT NULL,
      finished_at TEXT, status TEXT NOT NULL, error TEXT, items_processed INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_agent_job_runs_time ON agent_job_runs(started_at DESC);
    CREATE TABLE IF NOT EXISTS stock_provider_requests (
      id INTEGER PRIMARY KEY, provider TEXT NOT NULL, requested_at TEXT NOT NULL, status TEXT NOT NULL,
      ticker TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS idx_stock_provider_requests_time ON stock_provider_requests(provider, requested_at DESC);
    CREATE TABLE IF NOT EXISTS stock_corporate_actions (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id), kind TEXT NOT NULL,
      effective_date TEXT NOT NULL, ratio REAL, source_url TEXT NOT NULL, reviewed_at TEXT,
      UNIQUE(company_id, kind, effective_date));
    CREATE TABLE IF NOT EXISTS moomoo_oauth_clients (
      id INTEGER PRIMARY KEY CHECK(id=1), client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      registration_token_cipher TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS moomoo_oauth_sessions (
      state_hash TEXT PRIMARY KEY, verifier_cipher TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL, used_at TEXT);
    CREATE TABLE IF NOT EXISTS moomoo_oauth_tokens (
      id INTEGER PRIMARY KEY CHECK(id=1), access_cipher TEXT NOT NULL, refresh_cipher TEXT NOT NULL,
      token_type TEXT NOT NULL, scope TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS moomoo_provider_health (
      id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL, status TEXT NOT NULL, latency_ms INTEGER,
      http_status INTEGER, provider_timestamp TEXT, detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_moomoo_provider_health_time ON moomoo_provider_health(checked_at DESC);
    CREATE TABLE IF NOT EXISTS moomoo_quote_cache (
      cache_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, provider_timestamp TEXT,
      expires_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS moomoo_entitlements (
      id INTEGER PRIMARY KEY CHECK(id=1), market TEXT NOT NULL, capability TEXT NOT NULL,
      status TEXT NOT NULL, level TEXT, checked_at TEXT NOT NULL, evidence TEXT NOT NULL);
  `);
  const quoteColumns = new Set((db.prepare('PRAGMA table_info(stock_quotes)').all() as { name: string }[]).map(x => x.name));
  if (!quoteColumns.has('freshness')) db.exec("ALTER TABLE stock_quotes ADD COLUMN freshness TEXT NOT NULL DEFAULT 'DISCONNECTED'");
}

export function stockDb() {
  const db = getDatabase(); ensureStockSchema(db);
  if (!db.prepare("SELECT 1 FROM stock_meta WHERE key='watchlist_seeded'").get()) {
    seedWatchlist(db);
    db.prepare("INSERT OR IGNORE INTO stock_meta(key,value) VALUES('watchlist_seeded','1')").run();
  }
  if (!db.prepare("SELECT 1 FROM stock_meta WHERE key='starter_names_v1'").get()) {
    const update = db.prepare('UPDATE stock_companies SET name=?,updated_at=? WHERE ticker=? AND name=ticker');
    const now = new Date().toISOString();
    for (const ticker of starterTickers) update.run(starterNames[ticker], now, ticker);
    db.prepare("INSERT OR IGNORE INTO stock_meta(key,value) VALUES('starter_names_v1','1')").run();
  }
  return db;
}
export function seedWatchlist(db: Database.Database, now = new Date().toISOString()) {
  const insertCompany = db.prepare(`INSERT INTO stock_companies(ticker,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(ticker) DO NOTHING`);
  const insertWatch = db.prepare(`INSERT INTO stock_watchlist(company_id,date_added) SELECT id,? FROM stock_companies WHERE ticker=? ON CONFLICT(company_id) DO NOTHING`);
  const insertHistory = db.prepare(`INSERT INTO stock_ticker_history(company_id,ticker,valid_from) SELECT id,ticker,? FROM stock_companies WHERE ticker=? AND NOT EXISTS(SELECT 1 FROM stock_ticker_history h WHERE h.company_id=stock_companies.id)`);
  db.transaction(() => { for (const ticker of starterTickers) { insertCompany.run(ticker, starterNames[ticker], now, now); insertWatch.run(now, ticker); insertHistory.run(now, ticker); } })();
}
export function listWatchlist(db: Database.Database) {
  return db.prepare(`SELECT c.id AS companyId,c.ticker,c.name,c.sector,c.exchange,c.status,
    w.reference_price AS referencePrice,w.date_added AS dateAdded,w.notes,
    q.price,q.quote_at AS quoteAt,q.collected_at AS receivedAt,q.provider,q.quality,q.freshness,q.previous_close AS previousClose,q.volume,
    q.average_volume AS averageVolume
    FROM stock_watchlist w JOIN stock_companies c ON c.id=w.company_id
    LEFT JOIN stock_quotes q ON q.id=(SELECT id FROM stock_quotes WHERE company_id=c.id ORDER BY quote_at DESC,id DESC LIMIT 1)
    ORDER BY c.ticker`).all();
}
export function listRules(db: Database.Database): AlertRule[] {
  const rows = db.prepare(`SELECT r.*,c.ticker FROM stock_alert_rules r JOIN stock_companies c ON c.id=r.company_id ORDER BY r.created_at DESC`).all() as Record<string, unknown>[];
  return rows.map(x => ({ id: Number(x.id), companyId: Number(x.company_id), ticker: String(x.ticker), kind: x.kind as AlertKind,
    threshold: x.threshold === null ? null : Number(x.threshold), referencePrice: x.reference_price === null ? null : Number(x.reference_price),
    lowerBound: x.lower_bound === null ? null : Number(x.lower_bound), upperBound: x.upper_bound === null ? null : Number(x.upper_bound),
    volumeMultiple: x.volume_multiple === null ? null : Number(x.volume_multiple), cooldownMinutes: Number(x.cooldown_minutes),
    rearmPercent: Number(x.rearm_percent), active: Boolean(x.active), armed: Boolean(x.armed), lastTriggeredAt: x.last_triggered_at as string | null,
    createdAt: String(x.created_at), updatedAt: String(x.updated_at) }));
}
export function listEvents(db: Database.Database, limit = 50): AlertEvent[] {
  const rows = db.prepare(`SELECT e.*,c.ticker FROM stock_alert_events e JOIN stock_companies c ON c.id=e.company_id ORDER BY e.generated_at DESC,e.id DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
  return rows.map(x => ({ id: Number(x.id), ticker: String(x.ticker), ruleId: Number(x.rule_id), kind: x.kind as AlertKind,
    message: String(x.message), price: Number(x.price), quoteAt: String(x.quote_at), provider: String(x.provider), quality: x.quality as StockQuote['quality'],
    session: String(x.session), generatedAt: String(x.generated_at), sourceUrl: String(x.source_url) }));
}
export function findCompany(db: Database.Database, ticker: string) { return db.prepare('SELECT * FROM stock_companies WHERE ticker=?').get(ticker) as { id: number; ticker: string; name: string } | undefined; }
export function saveQuote(db: Database.Database, companyId: number, quote: StockQuote, collectedAt = new Date().toISOString()) {
  const freshness = quote.freshness ?? (quote.quality === 'REALTIME' ? 'LIVE' : quote.quality === 'STALE' ? 'STALE' : quote.quality === 'SAMPLE' ? 'DISCONNECTED' : 'DELAYED');
  db.prepare(`INSERT INTO stock_quotes(company_id,price,open,high,low,previous_close,volume,average_volume,week52_high,week52_low,quote_at,collected_at,provider,quality,freshness,source_url)
    VALUES(@companyId,@price,@open,@high,@low,@previousClose,@volume,@averageVolume,@week52High,@week52Low,@quoteAt,@collectedAt,@provider,@quality,@freshness,@sourceUrl)
    ON CONFLICT(company_id,quote_at,provider) DO UPDATE SET price=excluded.price,collected_at=excluded.collected_at,quality=excluded.quality,freshness=excluded.freshness`).run({ companyId, ...quote, freshness, collectedAt });
  if (quote.companyName) db.prepare('UPDATE stock_companies SET name=?,exchange=COALESCE(?,exchange),updated_at=? WHERE id=?').run(quote.companyName, quote.exchange, collectedAt, companyId);
}
export function jobRows(db: Database.Database): AgentJob[] { return db.prepare('SELECT id,kind,dedupe_key AS dedupeKey,payload_json AS payloadJson,next_run_at AS nextRunAt,cadence_seconds AS cadenceSeconds,status,attempts,max_attempts AS maxAttempts,lock_owner AS lockOwner,locked_until AS lockedUntil,last_error AS lastError FROM agent_jobs ORDER BY id').all() as AgentJob[]; }
