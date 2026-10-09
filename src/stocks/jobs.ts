import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { equityProvider, type EquityDataProvider } from './provider';
import { ProviderError } from './errors';
import { marketSession } from './session';
import { processAlertRules } from './alerts';
import { findCompany, listWatchlist, saveQuote } from './store';
import type { AgentJob } from './types';

const iso = (date: Date) => date.toISOString();
export function monitorCadenceMinutes(watchlistSize: number, budget = Number(process.env.STOCK_API_DAILY_BUDGET ?? 800)) {
  const requested = Math.max(5, Number(process.env.STOCK_MONITOR_MINUTES ?? 5));
  return Math.max(requested, Math.ceil(390 * watchlistSize / Math.max(1, budget)));
}
export function nextRegularOpen(after: Date) {
  const rounded = new Date(Math.ceil(after.getTime() / 900_000) * 900_000);
  for (let i = 0; i < 7 * 24 * 4 + 1; i++) { const candidate = new Date(rounded.getTime() + i * 900_000); if (marketSession(candidate).session === 'REGULAR') return candidate; }
  throw new Error('Cannot find next regular market session');
}
export function ensureMonitorJob(db: Database.Database, now = new Date()) {
  const watchlistSize = (db.prepare('SELECT COUNT(*) AS n FROM stock_watchlist').get() as { n: number }).n;
  const cadenceSeconds = monitorCadenceMinutes(watchlistSize) * 60;
  db.prepare(`INSERT INTO agent_jobs(kind,dedupe_key,payload_json,next_run_at,cadence_seconds,created_at,updated_at)
    VALUES('WATCHLIST_QUOTES','watchlist-quotes','{}',?,?,?,?)
    ON CONFLICT(dedupe_key) DO UPDATE SET cadence_seconds=excluded.cadence_seconds`).run(iso(now), cadenceSeconds, iso(now), iso(now));
}
export function enqueueMonitor(db: Database.Database, now = new Date()) {
  ensureMonitorJob(db, now);
  db.prepare(`UPDATE agent_jobs SET status='PENDING',next_run_at=?,attempts=0,last_error=NULL,updated_at=?
    WHERE dedupe_key='watchlist-quotes' AND status!='RUNNING'`).run(iso(now), iso(now));
}
export function claimJob(db: Database.Database, owner: string = randomUUID(), now = new Date()): AgentJob | null {
  const timestamp = iso(now), lockUntil = iso(new Date(now.getTime() + 15 * 60_000));
  db.prepare(`UPDATE agent_jobs SET status='RETRY',lock_owner=NULL,locked_until=NULL,updated_at=? WHERE status='RUNNING' AND locked_until<?`).run(timestamp, timestamp);
  const row = db.prepare(`UPDATE agent_jobs SET status='RUNNING',lock_owner=?,locked_until=?,updated_at=?
    WHERE id=(SELECT id FROM agent_jobs WHERE status IN ('PENDING','RETRY') AND next_run_at<=? ORDER BY next_run_at,id LIMIT 1)
    RETURNING id,kind,dedupe_key AS dedupeKey,payload_json AS payloadJson,next_run_at AS nextRunAt,cadence_seconds AS cadenceSeconds,status,attempts,max_attempts AS maxAttempts,lock_owner AS lockOwner,locked_until AS lockedUntil,last_error AS lastError`).get(owner, lockUntil, timestamp, timestamp) as AgentJob | undefined;
  if (row) db.prepare("INSERT INTO agent_job_runs(job_id,started_at,status) VALUES(?,?,'RUNNING')").run(row.id, timestamp);
  return row ?? null;
}
export function finishJob(db: Database.Database, job: AgentJob, result: { items: number } | { error: string; retryable: boolean }, now = new Date()) {
  const timestamp = iso(now);
  const run = db.prepare("SELECT id FROM agent_job_runs WHERE job_id=? AND status='RUNNING' ORDER BY id DESC LIMIT 1").get(job.id) as { id: number } | undefined;
  if ('error' in result) {
    const attempts = job.attempts + 1, failed = !result.retryable || attempts >= job.maxAttempts;
    const delay = Math.min(30 * 60_000, 30_000 * 2 ** (attempts - 1));
    db.prepare('UPDATE agent_jobs SET status=?,attempts=?,next_run_at=?,lock_owner=NULL,locked_until=NULL,last_error=?,updated_at=? WHERE id=? AND lock_owner=?')
      .run(failed ? 'FAILED' : 'RETRY', attempts, iso(new Date(now.getTime() + delay)), result.error.slice(0, 500), timestamp, job.id, job.lockOwner);
    if (run) db.prepare("UPDATE agent_job_runs SET status=?,finished_at=?,error=? WHERE id=?").run(failed ? 'FAILED' : 'RETRY', timestamp, result.error.slice(0, 500), run.id);
  } else {
    const next = job.cadenceSeconds ? new Date(now.getTime() + job.cadenceSeconds * 1000) : null;
    const nextDue = next && marketSession(next).session !== 'REGULAR' ? nextRegularOpen(next) : next;
    db.prepare('UPDATE agent_jobs SET status=?,attempts=0,next_run_at=?,lock_owner=NULL,locked_until=NULL,last_error=NULL,updated_at=? WHERE id=? AND lock_owner=?')
      .run(nextDue ? 'PENDING' : 'DONE', nextDue ? iso(nextDue) : timestamp, timestamp, job.id, job.lockOwner);
    if (run) db.prepare("UPDATE agent_job_runs SET status='DONE',finished_at=?,items_processed=? WHERE id=?").run(timestamp, result.items, run.id);
  }
}
async function acquireProviderSlot(db: Database.Database, provider: string, ticker: string) {
  const maxPerMinute = Math.max(1, Number(process.env.STOCK_API_PER_MINUTE ?? 8));
  const dailyBudget = Math.max(1, Number(process.env.STOCK_API_DAILY_BUDGET ?? 800));
  for (;;) {
    const now = new Date();
    const minuteAgo = iso(new Date(now.getTime() - 60_000));
    const dayAgo = iso(new Date(now.getTime() - 86_400_000));
    const minute = (db.prepare('SELECT COUNT(*) AS n FROM stock_provider_requests WHERE provider=? AND requested_at>=?').get(provider, minuteAgo) as { n: number }).n;
    const daily = (db.prepare('SELECT COUNT(*) AS n FROM stock_provider_requests WHERE provider=? AND requested_at>=?').get(provider, dayAgo) as { n: number }).n;
    if (daily >= dailyBudget) throw new ProviderError('Configured daily market-data request budget exhausted', false);
    if (minute < maxPerMinute) { const row = db.prepare("INSERT INTO stock_provider_requests(provider,requested_at,status,ticker) VALUES(?,?,'PENDING',?)").run(provider, iso(now), ticker); return Number(row.lastInsertRowid); }
    const oldest = db.prepare('SELECT requested_at AS at FROM stock_provider_requests WHERE provider=? AND requested_at>=? ORDER BY requested_at LIMIT 1').get(provider, minuteAgo) as { at: string };
    await new Promise(resolve => setTimeout(resolve, Math.max(100, Date.parse(oldest.at) + 60_100 - now.getTime())));
  }
}
export async function executeMonitor(db: Database.Database, provider: EquityDataProvider = equityProvider(), now = new Date()) {
  if (marketSession(now).session !== 'REGULAR' && provider.id !== 'SAMPLE') return { items: 0 };
  const watchlist = listWatchlist(db) as { ticker: string }[];
  let items = 0;
  if (provider.getQuotes && watchlist.length) {
    let requestId: number | null = null;
    if (provider.id !== 'SAMPLE') requestId = await acquireProviderSlot(db, provider.id, watchlist.map(x => x.ticker).join(','));
    try {
      const quotes = await provider.getQuotes(watchlist.map(x => x.ticker));
      const byTicker = new Map(quotes.map(x => [x.ticker, x]));
      for (const item of watchlist) {
        const quote = byTicker.get(item.ticker);
        if (!quote) throw new ProviderError(`Provider omitted ${item.ticker} from its batch response`, false);
        const company = findCompany(db, item.ticker)!;
        saveQuote(db, company.id, quote);
        processAlertRules(db, company.id, quote);
        items++;
      }
      if (requestId) db.prepare("UPDATE stock_provider_requests SET status='SUCCESS' WHERE id=?").run(requestId);
      return { items };
    } catch (error) {
      if (requestId) db.prepare("UPDATE stock_provider_requests SET status='ERROR',error=? WHERE id=?").run(error instanceof Error ? error.message.slice(0, 500) : 'Unknown error', requestId);
      throw error;
    }
  }
  for (const item of watchlist) {
    let requestId: number | null = null;
    if (provider.id !== 'SAMPLE') requestId = await acquireProviderSlot(db, provider.id, item.ticker);
    try {
      const quote = await provider.getQuote(item.ticker);
      const company = findCompany(db, item.ticker)!;
      saveQuote(db, company.id, quote);
      processAlertRules(db, company.id, quote);
      if (requestId) db.prepare("UPDATE stock_provider_requests SET status='SUCCESS' WHERE id=?").run(requestId);
      items++;
    } catch (error) {
      if (requestId) db.prepare("UPDATE stock_provider_requests SET status='ERROR',error=? WHERE id=?").run(error instanceof Error ? error.message.slice(0, 500) : 'Unknown error', requestId);
      throw error;
    }
  }
  return { items };
}
export async function runOneJob(db: Database.Database, provider?: EquityDataProvider, now = new Date()) {
  const job = claimJob(db, undefined, now);
  if (!job) return null;
  try {
    const result = job.kind === 'WATCHLIST_QUOTES' ? await executeMonitor(db, provider, now) : { items: 0 };
    finishJob(db, job, result, new Date());
    return { job, result, status: 'DONE' as const };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown job error';
    finishJob(db, job, { error: reason, retryable: error instanceof ProviderError ? error.retryable : true }, new Date());
    return { job, error: reason, status: 'ERROR' as const };
  }
}
