import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { claimJob, ensureMonitorJob, executeMonitor, finishJob, monitorCadenceMinutes } from './jobs';
import { ensureStockSchema, seedWatchlist } from './store';
import type { EquityDataProvider } from './provider';
import type { StockQuote } from './types';

test('persistent queue claims once, retries with backoff and records history', () => {
  const db = new Database(':memory:'); ensureStockSchema(db); seedWatchlist(db);
  const start = new Date('2026-10-09T14:00:00Z'); ensureMonitorJob(db, start);
  const first = claimJob(db, 'worker-a', start);
  assert.ok(first); assert.equal(claimJob(db, 'worker-b', start), null);
  finishJob(db, first, { error: 'rate limited', retryable: true }, start);
  assert.equal(claimJob(db, 'worker-b', new Date('2026-10-09T14:00:10Z')), null);
  const second = claimJob(db, 'worker-b', new Date('2026-10-09T14:00:31Z'));
  assert.ok(second); assert.equal(second.attempts, 1);
  finishJob(db, second, { items: 9 }, new Date('2026-10-09T14:01:00Z'));
  const row = db.prepare('SELECT status,attempts FROM agent_jobs').get() as { status: string; attempts: number };
  assert.equal(row.status, 'PENDING'); assert.equal(row.attempts, 0);
  assert.deepEqual((db.prepare('SELECT status FROM agent_job_runs ORDER BY id').all() as { status: string }[]).map(x => x.status), ['RETRY', 'DONE']);
  db.close();
});
test('cadence expands to stay within configured provider budget', () => {
  assert.equal(monitorCadenceMinutes(9, 800), 5);
  assert.equal(monitorCadenceMinutes(9, 150), 24);
});
test('mocked provider integrates quote storage and alert generation', async () => {
  const db = new Database(':memory:'); ensureStockSchema(db); seedWatchlist(db);
  const company = db.prepare("SELECT id FROM stock_companies WHERE ticker='MSFT'").get() as { id: number };
  db.prepare(`INSERT INTO stock_alert_rules(company_id,kind,threshold,created_at,updated_at) VALUES(?,'PRICE_BELOW',95,?,?)`).run(company.id,'2026-10-09','2026-10-09');
  const provider: EquityDataProvider = { id: 'SAMPLE', async getDailyBars() { return []; }, async getQuote(ticker): Promise<StockQuote> { return { ticker, companyName: ticker, exchange: 'NASDAQ', price: 90, open: 90, high: 91, low: 89, previousClose: 100, volume: 1000, averageVolume: 1000, week52High: 150, week52Low: 80, quoteAt: '2026-10-09T15:00:00.000Z', provider: 'SAMPLE', quality: ticker === 'MSFT' ? 'REALTIME' : 'SAMPLE', sourceUrl: 'https://example.com' }; } };
  const result = await executeMonitor(db, provider, new Date('2026-10-09T15:00:00Z'));
  assert.equal(result.items, 9);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM stock_quotes').get() as { n: number }).n, 9);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM stock_alert_events').get() as { n: number }).n, 1);
  db.close();
});
