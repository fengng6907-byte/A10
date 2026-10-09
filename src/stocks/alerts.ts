import type Database from 'better-sqlite3';
import { marketSession } from './session';
import type { AlertRule, StockQuote } from './types';

export function alertCondition(rule: AlertRule, quote: StockQuote) {
  const t = rule.threshold ?? 0, p = quote.price, ref = rule.referencePrice ?? quote.previousClose;
  const volumeRatio = quote.volume !== null && quote.averageVolume && quote.averageVolume > 0 ? quote.volume / quote.averageVolume : null;
  const pct = ref && ref > 0 ? (p - ref) / ref * 100 : null;
  const gap = quote.open !== null && quote.previousClose && quote.previousClose > 0 ? (quote.open - quote.previousClose) / quote.previousClose * 100 : null;
  let met = false, rearmed = false, detail = '';
  const h = rule.rearmPercent / 100;
  switch (rule.kind) {
    case 'PRICE_BELOW': met = p <= t; rearmed = p >= t * (1 + h); detail = `Price ${p.toFixed(2)} at or below ${t.toFixed(2)}`; break;
    case 'PRICE_ABOVE': met = p >= t; rearmed = p <= t * (1 - h); detail = `Price ${p.toFixed(2)} at or above ${t.toFixed(2)}`; break;
    case 'PERCENT_DROP': met = pct !== null && pct <= -t; rearmed = pct !== null && pct >= -t + rule.rearmPercent; detail = `${pct?.toFixed(2) ?? 'unavailable'}% from reference ${ref?.toFixed(2) ?? 'unavailable'}`; break;
    case 'PERCENT_INCREASE': met = pct !== null && pct >= t; rearmed = pct !== null && pct <= t - rule.rearmPercent; detail = `${pct?.toFixed(2) ?? 'unavailable'}% from reference ${ref?.toFixed(2) ?? 'unavailable'}`; break;
    case 'WEEK_52_HIGH': met = quote.week52High !== null && p >= quote.week52High; rearmed = quote.week52High !== null && p <= quote.week52High * (1 - h); detail = `Price ${p.toFixed(2)} versus 52-week high ${quote.week52High?.toFixed(2) ?? 'unavailable'}`; break;
    case 'WEEK_52_LOW': met = quote.week52Low !== null && p <= quote.week52Low; rearmed = quote.week52Low !== null && p >= quote.week52Low * (1 + h); detail = `Price ${p.toFixed(2)} versus 52-week low ${quote.week52Low?.toFixed(2) ?? 'unavailable'}`; break;
    case 'UNUSUAL_VOLUME': met = volumeRatio !== null && volumeRatio >= t; rearmed = volumeRatio !== null && volumeRatio <= Math.max(1, t - rule.rearmPercent); detail = `Volume ${volumeRatio?.toFixed(2) ?? 'unavailable'}× average`; break;
    case 'GAP_OPEN': met = gap !== null && Math.abs(gap) >= t; rearmed = gap !== null && Math.abs(gap) <= Math.max(0, t - rule.rearmPercent); detail = `Opening gap ${gap?.toFixed(2) ?? 'unavailable'}%`; break;
    case 'VALUATION_RANGE': met = rule.lowerBound !== null && rule.upperBound !== null && p >= rule.lowerBound && p <= rule.upperBound; rearmed = rule.lowerBound !== null && rule.upperBound !== null && (p < rule.lowerBound * (1 - h) || p > rule.upperBound * (1 + h)); detail = `Price ${p.toFixed(2)} entered configured value range ${rule.lowerBound?.toFixed(2)}–${rule.upperBound?.toFixed(2)}`; break;
  }
  if (rule.volumeMultiple && rule.kind !== 'UNUSUAL_VOLUME') { met = met && volumeRatio !== null && volumeRatio >= rule.volumeMultiple; detail += `; volume ${volumeRatio?.toFixed(2) ?? 'unavailable'}× average (required ${rule.volumeMultiple.toFixed(2)}×)`; }
  return { met, rearmed, detail };
}

export function processAlertRules(db: Database.Database, companyId: number, quote: StockQuote, now = new Date()) {
  if (!['REALTIME', 'DELAYED', 'EOD'].includes(quote.quality)) return 0;
  const rows = db.prepare('SELECT r.*,c.ticker FROM stock_alert_rules r JOIN stock_companies c ON c.id=r.company_id WHERE r.company_id=? AND r.active=1').all(companyId) as Record<string, unknown>[];
  let generated = 0;
  for (const x of rows) {
    const rule: AlertRule = { id: Number(x.id), companyId, ticker: String(x.ticker), kind: x.kind as AlertRule['kind'],
      threshold: x.threshold === null ? null : Number(x.threshold), referencePrice: x.reference_price === null ? null : Number(x.reference_price),
      lowerBound: x.lower_bound === null ? null : Number(x.lower_bound), upperBound: x.upper_bound === null ? null : Number(x.upper_bound),
      volumeMultiple: x.volume_multiple === null ? null : Number(x.volume_multiple), cooldownMinutes: Number(x.cooldown_minutes), rearmPercent: Number(x.rearm_percent),
      active: true, armed: Boolean(x.armed), lastTriggeredAt: x.last_triggered_at as string | null, createdAt: String(x.created_at), updatedAt: String(x.updated_at) };
    const condition = alertCondition(rule, quote);
    if (!rule.armed) {
      if (condition.rearmed) db.prepare('UPDATE stock_alert_rules SET armed=1,updated_at=? WHERE id=?').run(now.toISOString(), rule.id);
      continue;
    }
    if (!condition.met) continue;
    if (rule.lastTriggeredAt && now.getTime() - Date.parse(rule.lastTriggeredAt) < rule.cooldownMinutes * 60_000) continue;
    const fingerprint = `${rule.id}:${quote.provider}:${quote.quoteAt}`;
    const session = marketSession(new Date(quote.quoteAt)).session;
    const message = `${rule.ticker}: ${condition.detail}. Quote ${quote.quality.toLowerCase()} from ${quote.provider} at ${quote.quoteAt}.`;
    const changed = db.prepare(`INSERT INTO stock_alert_events(company_id,rule_id,fingerprint,kind,message,price,quote_at,provider,quality,session,generated_at,source_url)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO NOTHING`).run(companyId, rule.id, fingerprint, rule.kind, message, quote.price, quote.quoteAt, quote.provider, quote.quality, session, now.toISOString(), quote.sourceUrl).changes;
    if (changed) { db.prepare('UPDATE stock_alert_rules SET armed=0,last_triggered_at=?,updated_at=? WHERE id=?').run(now.toISOString(), now.toISOString(), rule.id); generated++; }
  }
  return generated;
}
