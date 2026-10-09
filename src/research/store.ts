import type Database from 'better-sqlite3';
import { stockDb } from '@/stocks/store';

export function ensureResearchSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_company_profiles (
      company_id INTEGER PRIMARY KEY REFERENCES stock_companies(id), cik TEXT, industry TEXT, sic TEXT,
      listing_date TEXT, ipo_price REAL, market_cap REAL, description TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_sources (
      id INTEGER PRIMARY KEY, company_id INTEGER REFERENCES stock_companies(id), source_type TEXT NOT NULL,
      external_id TEXT NOT NULL, title TEXT NOT NULL, publisher TEXT NOT NULL, url TEXT NOT NULL,
      published_at TEXT, collected_at TEXT NOT NULL, content_hash TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '',
      factuality TEXT NOT NULL DEFAULT 'PRIMARY_SOURCE', processing_status TEXT NOT NULL DEFAULT 'COLLECTED', raw_json TEXT,
      UNIQUE(source_type, external_id));
    CREATE INDEX IF NOT EXISTS idx_research_profiles_cik ON research_company_profiles(cik);
    CREATE INDEX IF NOT EXISTS idx_research_sources_company_time ON research_sources(company_id,published_at DESC);
    CREATE TABLE IF NOT EXISTS research_filings (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id), source_id INTEGER NOT NULL REFERENCES research_sources(id),
      cik TEXT NOT NULL, form TEXT NOT NULL, filing_date TEXT NOT NULL, reporting_period TEXT, accession_number TEXT NOT NULL UNIQUE,
      source_url TEXT NOT NULL, collected_at TEXT NOT NULL, processing_status TEXT NOT NULL DEFAULT 'COLLECTED');
    CREATE INDEX IF NOT EXISTS idx_research_filings_company ON research_filings(company_id,filing_date DESC);
    CREATE TABLE IF NOT EXISTS research_periods (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id), fiscal_year INTEGER,
      fiscal_period TEXT, period_start TEXT, period_end TEXT NOT NULL, form TEXT NOT NULL, filed_at TEXT NOT NULL,
      accession_number TEXT, source_id INTEGER REFERENCES research_sources(id), is_restatement INTEGER NOT NULL DEFAULT 0,
      UNIQUE(company_id,period_start,period_end,form,filed_at));
    CREATE TABLE IF NOT EXISTS research_financial_metrics (
      id INTEGER PRIMARY KEY, period_id INTEGER NOT NULL REFERENCES research_periods(id), metric TEXT NOT NULL,
      value REAL NOT NULL, unit TEXT NOT NULL, source_id INTEGER REFERENCES research_sources(id), context_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(period_id,metric));
    CREATE INDEX IF NOT EXISTS idx_research_metrics_period ON research_financial_metrics(period_id,metric);
    CREATE TABLE IF NOT EXISTS research_announcements (
      id INTEGER PRIMARY KEY, company_id INTEGER REFERENCES stock_companies(id), source_id INTEGER NOT NULL REFERENCES research_sources(id) UNIQUE,
      event_type TEXT NOT NULL, materiality TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS research_news (
      id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES research_sources(id) UNIQUE,
      tickers_json TEXT NOT NULL, materiality TEXT NOT NULL, is_opinion INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS research_financial_changes (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id), metric TEXT NOT NULL,
      comparison TEXT NOT NULL, from_period_id INTEGER REFERENCES research_periods(id), to_period_id INTEGER NOT NULL REFERENCES research_periods(id),
      old_value REAL NOT NULL, new_value REAL NOT NULL, absolute_change REAL NOT NULL, percent_change REAL,
      direction TEXT NOT NULL, materiality TEXT NOT NULL, evidence_ids_json TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
      detected_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_change_classifications (
      id INTEGER PRIMARY KEY, change_id INTEGER NOT NULL UNIQUE REFERENCES research_financial_changes(id),
      is_material INTEGER NOT NULL, category TEXT NOT NULL, rationale TEXT NOT NULL, evidence_ids_json TEXT NOT NULL,
      model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0, status TEXT NOT NULL, classified_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_screenings (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id), category TEXT NOT NULL,
      quality_score REAL, growth_score REAL, completeness REAL NOT NULL, rank INTEGER, previous_rank INTEGER,
      reasons_json TEXT NOT NULL, risks_json TEXT NOT NULL, components_json TEXT NOT NULL, input_hash TEXT NOT NULL,
      evaluated_at TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1, UNIQUE(company_id,category,input_hash));
    CREATE INDEX IF NOT EXISTS idx_research_screenings_current ON research_screenings(category,is_current,rank);
    CREATE TABLE IF NOT EXISTS research_ranking_changes (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id), category TEXT NOT NULL,
      change_type TEXT NOT NULL, previous_rank INTEGER, current_rank INTEGER NOT NULL, screening_id INTEGER REFERENCES research_screenings(id),
      fingerprint TEXT NOT NULL UNIQUE, detected_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_reports (
      id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES stock_companies(id), input_hash TEXT NOT NULL,
      data_cutoff TEXT NOT NULL, model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0, generation_status TEXT NOT NULL, assessment TEXT,
      report_json TEXT, evidence_ids_json TEXT NOT NULL, generated_at TEXT NOT NULL, error TEXT,
      UNIQUE(company_id,input_hash));
    CREATE INDEX IF NOT EXISTS idx_research_reports_company ON research_reports(company_id,generated_at DESC);
    CREATE TABLE IF NOT EXISTS research_notifications (
      id INTEGER PRIMARY KEY, company_id INTEGER REFERENCES stock_companies(id), category TEXT NOT NULL, priority TEXT NOT NULL,
      event_at TEXT NOT NULL, title TEXT NOT NULL, why_it_matters TEXT NOT NULL, risks TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL, target_url TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
      group_key TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT, delivery_status TEXT NOT NULL DEFAULT 'PENDING');
    CREATE INDEX IF NOT EXISTS idx_research_notifications_time ON research_notifications(created_at DESC);
    CREATE TABLE IF NOT EXISTS research_notification_preferences (
      id INTEGER PRIMARY KEY CHECK(id=1), enabled_categories_json TEXT NOT NULL, minimum_priority TEXT NOT NULL DEFAULT 'LOW',
      in_app_enabled INTEGER NOT NULL DEFAULT 1, email_enabled INTEGER NOT NULL DEFAULT 0, email_address TEXT,
      cooldown_minutes INTEGER NOT NULL DEFAULT 240, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_notification_deliveries (
      id INTEGER PRIMARY KEY, notification_id INTEGER NOT NULL REFERENCES research_notifications(id), channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
      delivered_at TEXT, last_error TEXT, UNIQUE(notification_id,channel));
    CREATE TABLE IF NOT EXISTS research_briefings (
      id INTEGER PRIMARY KEY, briefing_date_sg TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, status TEXT NOT NULL,
      briefing_json TEXT NOT NULL, generated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS research_collection_runs (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, cursor TEXT, started_at TEXT NOT NULL, finished_at TEXT,
      status TEXT NOT NULL, items_processed INTEGER NOT NULL DEFAULT 0, items_created INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE INDEX IF NOT EXISTS idx_research_runs_time ON research_collection_runs(started_at DESC);
  `);
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO research_notification_preferences
    (id,enabled_categories_json,minimum_priority,in_app_enabled,email_enabled,cooldown_minutes,updated_at)
    VALUES(1,?,'LOW',1,0,240,?)`).run(JSON.stringify([
      'NEW_STOCK_DISCOVERED','FINANCIAL_PERFORMANCE_CHANGE','SIGNIFICANT_COMPANY_ANNOUNCEMENT',
      'VALUATION_THRESHOLD_REACHED','RESEARCH_RATING_CHANGED','MATERIAL_INVESTMENT_RISK','DAILY_INVESTMENT_BRIEF_READY',
    ]), now);
}

export function researchDb() { const db = stockDb(); ensureResearchSchema(db); return db; }

export function startRun(db: Database.Database, kind: string, cursor: string | null = null, now = new Date().toISOString()) {
  return Number(db.prepare(`INSERT INTO research_collection_runs(kind,cursor,started_at,status) VALUES(?,?,?,'RUNNING')`).run(kind,cursor,now).lastInsertRowid);
}
export function finishRun(db: Database.Database, id: number, status: 'DONE'|'FAILED', processed: number, created: number, error?: string) {
  db.prepare(`UPDATE research_collection_runs SET finished_at=?,status=?,items_processed=?,items_created=?,error=? WHERE id=?`)
    .run(new Date().toISOString(),status,processed,created,error ?? null,id);
}

export function dashboardData(db = researchDb()) {
  return {
    discoveries: db.prepare(`SELECT s.*,c.ticker,c.name,p.industry,p.market_cap AS marketCap,p.listing_date AS listingDate
      FROM research_screenings s JOIN stock_companies c ON c.id=s.company_id LEFT JOIN research_company_profiles p ON p.company_id=c.id
      WHERE s.is_current=1 ORDER BY COALESCE(s.rank,999999),s.evaluated_at DESC LIMIT 100`).all(),
    notifications: db.prepare(`SELECT n.*,c.ticker,c.name,COUNT(*) OVER(PARTITION BY n.group_key) AS groupCount FROM research_notifications n LEFT JOIN stock_companies c ON c.id=n.company_id ORDER BY n.created_at DESC LIMIT 100`).all(),
    reports: db.prepare(`SELECT r.id,r.company_id AS companyId,c.ticker,c.name,r.assessment,r.data_cutoff AS dataCutoff,r.model,r.generation_status AS generationStatus,r.generated_at AS generatedAt
      FROM research_reports r JOIN stock_companies c ON c.id=r.company_id ORDER BY r.generated_at DESC LIMIT 50`).all(),
    rankingChanges: db.prepare(`SELECT r.*,c.ticker,c.name FROM research_ranking_changes r JOIN stock_companies c ON c.id=r.company_id ORDER BY r.detected_at DESC LIMIT 100`).all(),
    briefings: db.prepare(`SELECT * FROM research_briefings ORDER BY briefing_date_sg DESC LIMIT 30`).all(),
    runs: db.prepare(`SELECT * FROM research_collection_runs ORDER BY id DESC LIMIT 30`).all(),
    preferences: db.prepare(`SELECT * FROM research_notification_preferences WHERE id=1`).get(),
  };
}
