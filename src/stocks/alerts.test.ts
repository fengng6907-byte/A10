import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { alertCondition, processAlertRules } from './alerts';
import { ensureStockSchema, seedWatchlist } from './store';
import type { AlertRule, StockQuote } from './types';

const quote = (price: number, at = '2026-10-09T15:00:00.000Z'): StockQuote => ({ ticker: 'MSFT', companyName: 'Microsoft', exchange: 'NASDAQ', price, open: price,
  high: price * 1.01, low: price * .99, previousClose: 100, volume: 3_000_000, averageVolume: 1_000_000,
  week52High: 120, week52Low: 80, quoteAt: at, provider: 'TEST', quality: 'REALTIME', sourceUrl: 'https://example.com/quote' });
const rule = (kind: AlertRule['kind'], threshold: number | null, extras: Partial<AlertRule> = {}): AlertRule => ({ id: 1, companyId: 1, ticker: 'MSFT', kind,
  threshold, referencePrice: null, lowerBound: null, upperBound: null, volumeMultiple: null, cooldownMinutes: 60, rearmPercent: 1,
  active: true, armed: true, lastTriggeredAt: null, createdAt: '', updatedAt: '', ...extras });

test('price, percentage, 52-week, volume and gap thresholds', () => {
  assert.equal(alertCondition(rule('PRICE_BELOW', 95), quote(94)).met, true);
  assert.equal(alertCondition(rule('PRICE_ABOVE', 95), quote(94)).met, false);
  assert.equal(alertCondition(rule('PERCENT_DROP', 5), quote(94)).met, true);
  assert.equal(alertCondition(rule('PERCENT_INCREASE', 5), quote(106)).met, true);
  assert.equal(alertCondition(rule('WEEK_52_HIGH', null), quote(120)).met, true);
  assert.equal(alertCondition(rule('WEEK_52_LOW', null), quote(80)).met, true);
  assert.equal(alertCondition(rule('UNUSUAL_VOLUME', 2), quote(100)).met, true);
  assert.equal(alertCondition(rule('GAP_OPEN', 5), { ...quote(100), open: 106 }).met, true);
  assert.equal(alertCondition(rule('VALUATION_RANGE', null, { lowerBound: 90, upperBound: 110 }), quote(100)).met, true);
  assert.equal(alertCondition(rule('PRICE_ABOVE', 105, { volumeMultiple: 4 }), quote(106)).met, false);
});
test('alert deduplicates a quote, respects cooldown and rearms after retreat', () => {
  const db = new Database(':memory:'); ensureStockSchema(db); seedWatchlist(db);
  const company = db.prepare("SELECT id FROM stock_companies WHERE ticker='MSFT'").get() as { id: number };
  db.prepare(`INSERT INTO stock_alert_rules(company_id,kind,threshold,cooldown_minutes,rearm_percent,created_at,updated_at) VALUES(?,'PRICE_BELOW',95,60,1,?,?)`).run(company.id,'2026-10-09','2026-10-09');
  assert.equal(processAlertRules(db, company.id, quote(94), new Date('2026-10-09T15:00:00Z')), 1);
  assert.equal(processAlertRules(db, company.id, quote(94), new Date('2026-10-09T15:01:00Z')), 0);
  assert.equal(processAlertRules(db, company.id, quote(97, '2026-10-09T15:05:00Z'), new Date('2026-10-09T15:05:00Z')), 0);
  assert.equal(processAlertRules(db, company.id, quote(94, '2026-10-09T15:10:00Z'), new Date('2026-10-09T15:10:00Z')), 0);
  processAlertRules(db, company.id, quote(97, '2026-10-09T16:02:00Z'), new Date('2026-10-09T16:02:00Z'));
  assert.equal(processAlertRules(db, company.id, quote(94, '2026-10-09T16:03:00Z'), new Date('2026-10-09T16:03:00Z')), 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM stock_alert_events').get() as { n: number }).n, 2);
  db.close();
});
test('sample and stale quotes cannot generate alerts', () => {
  const db = new Database(':memory:'); ensureStockSchema(db); seedWatchlist(db);
  const company = db.prepare("SELECT id FROM stock_companies WHERE ticker='MSFT'").get() as { id: number };
  db.prepare(`INSERT INTO stock_alert_rules(company_id,kind,threshold,created_at,updated_at) VALUES(?,'PRICE_BELOW',95,?,?)`).run(company.id,'2026-10-09','2026-10-09');
  assert.equal(processAlertRules(db, company.id, { ...quote(90), quality: 'SAMPLE' }), 0);
  assert.equal(processAlertRules(db, company.id, { ...quote(90), quality: 'STALE' }), 0);
  db.close();
});
