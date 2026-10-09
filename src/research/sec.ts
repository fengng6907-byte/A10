import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { findCompany } from '@/stocks/store';
import type { FinancialMetricName, NormalizedFact } from './types';

const SEC_BASE = 'https://data.sec.gov';
const SEC_WWW = 'https://www.sec.gov';
const supportedForms = new Set(['10-K','10-K/A','10-Q','10-Q/A','8-K','8-K/A','S-1','S-1/A']);
const concepts: Record<FinancialMetricName, string[]> = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax','Revenues','SalesRevenueNet'],
  net_income: ['NetIncomeLoss','ProfitLoss'],
  eps_diluted: ['EarningsPerShareDiluted'],
  gross_profit: ['GrossProfit'],
  operating_income: ['OperatingIncomeLoss'],
  operating_cash_flow: ['NetCashProvidedByUsedInOperatingActivities'],
  capital_expenditure: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  free_cash_flow: [],
  cash_and_equivalents: ['CashAndCashEquivalentsAtCarryingValue','CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
  debt: ['LongTermDebtAndFinanceLeaseObligationsCurrentAndNoncurrent','LongTermDebtAndCapitalLeaseObligations','LongTermDebt'],
  outstanding_shares: ['CommonStockSharesOutstanding','EntityCommonStockSharesOutstanding'],
};

type SecFactUnit = { val: number; start?: string; end: string; fy?: number; fp?: string; form?: string; filed: string; accn?: string; frame?: string };
type CompanyFacts = { cik: number; entityName: string; facts?: { 'us-gaap'?: Record<string,{ units?: Record<string,SecFactUnit[]> }> }; };
export type SecSubmission = { cik: string; name: string; sic?:string; sicDescription?:string; description?:string; tickers?: string[]; exchanges?: string[]; formerNames?: { name: string; from: string; to: string }[]; filings?: { recent?: Record<string,string[]> } };

export function hashText(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function padCik(cik: string | number) { return String(cik).replace(/\D/g,'').padStart(10,'0'); }
export function filingUrl(cik: string, accession: string, primaryDocument: string) {
  return `${SEC_WWW}/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g,'')}/${primaryDocument}`;
}

export class SecClient {
  private lastRequest = 0;
  constructor(private userAgent = process.env.SEC_USER_AGENT ?? '') {}
  private async json<T>(url: string): Promise<T> {
    if (!this.userAgent || !this.userAgent.includes('@')) throw new Error('SEC_USER_AGENT must identify the application and include a contact email');
    const wait = Math.max(0, 125 - (Date.now() - this.lastRequest));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    this.lastRequest = Date.now();
    const response = await fetch(url, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`SEC request failed (${response.status}) for ${url}`);
    return response.json() as Promise<T>;
  }
  tickerMap() { return this.json<Record<string,{ cik_str: number; ticker: string; title: string }>>(`${SEC_WWW}/files/company_tickers.json`); }
  submissions(cik: string) { return this.json<SecSubmission>(`${SEC_BASE}/submissions/CIK${padCik(cik)}.json`); }
  companyFacts(cik: string) { return this.json<CompanyFacts>(`${SEC_BASE}/api/xbrl/companyfacts/CIK${padCik(cik)}.json`); }
}

function preferredUnit(metric: FinancialMetricName, units: Record<string,SecFactUnit[]>): [string,SecFactUnit[]] | null {
  const order = metric === 'eps_diluted' ? ['USD/shares','USD-per-shares'] : metric === 'outstanding_shares' ? ['shares'] : ['USD'];
  for (const unit of order) if (units[unit]) return [unit, units[unit]];
  const first = Object.entries(units)[0];
  return first ?? null;
}

export function normalizeCompanyFacts(payload: CompanyFacts): NormalizedFact[] {
  const gaap = payload.facts?.['us-gaap'] ?? {};
  const result = new Map<string,NormalizedFact>();
  for (const [metric, aliases] of Object.entries(concepts) as [FinancialMetricName,string[]][]) {
    for (const concept of aliases) {
      const chosen = preferredUnit(metric, gaap[concept]?.units ?? {});
      if (!chosen) continue;
      const [unit, values] = chosen;
      for (const fact of values) {
        const form = fact.form ?? '';
        if (!supportedForms.has(form) || !Number.isFinite(fact.val) || !fact.end || !fact.filed) continue;
        const key = [metric,fact.start ?? '',fact.end,fact.fy ?? '',fact.fp ?? '',form].join('|');
        const normalized: NormalizedFact = { metric, value: fact.val, unit, start: fact.start ?? null, end: fact.end,
          fiscalYear: fact.fy ?? null, fiscalPeriod: fact.fp ?? null, form, filedAt: fact.filed,
          accession: fact.accn ?? null, frame: fact.frame ?? null };
        const prior = result.get(key);
        if (!prior || normalized.filedAt > prior.filedAt) result.set(key, normalized);
      }
      if ([...result.values()].some(x => x.metric === metric)) break;
    }
  }
  const byContext = new Map<string,Map<FinancialMetricName,NormalizedFact>>();
  for (const fact of result.values()) {
    const key = [fact.start ?? '',fact.end,fact.fiscalYear ?? '',fact.fiscalPeriod ?? '',fact.form,fact.filedAt].join('|');
    const row = byContext.get(key) ?? new Map(); row.set(fact.metric,fact); byContext.set(key,row);
  }
  for (const row of byContext.values()) {
    const ocf = row.get('operating_cash_flow'), capex = row.get('capital_expenditure');
    if (ocf && capex && ocf.unit === capex.unit) {
      const fcf: NormalizedFact = { ...ocf, metric: 'free_cash_flow', value: ocf.value - Math.abs(capex.value) };
      result.set(['free_cash_flow',fcf.start ?? '',fcf.end,fcf.fiscalYear ?? '',fcf.fiscalPeriod ?? '',fcf.form].join('|'),fcf);
    }
  }
  return [...result.values()].sort((a,b) => a.end.localeCompare(b.end) || a.metric.localeCompare(b.metric));
}

function sourceId(db: Database.Database, input: { companyId: number; type: string; externalId: string; title: string; url: string; publishedAt?: string | null; hash: string; raw?: string }) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO research_sources(company_id,source_type,external_id,title,publisher,url,published_at,collected_at,content_hash,excerpt,factuality,processing_status,raw_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,'PRIMARY_SOURCE','COLLECTED',?) ON CONFLICT(source_type,external_id) DO UPDATE SET collected_at=excluded.collected_at,content_hash=excluded.content_hash,processing_status='COLLECTED'`)
    .run(input.companyId,input.type,input.externalId,input.title,'U.S. Securities and Exchange Commission',input.url,input.publishedAt ?? null,now,input.hash,'Official SEC filing or structured XBRL data.',input.raw ?? null);
  return Number((db.prepare('SELECT id FROM research_sources WHERE source_type=? AND external_id=?').get(input.type,input.externalId) as {id:number}).id);
}

export function upsertSecCompany(db: Database.Database, ticker: string, cik: string, name: string, exchange?: string | null) {
  const now = new Date().toISOString(), clean = ticker.trim().toUpperCase();
  db.prepare(`INSERT INTO stock_companies(ticker,name,exchange,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(ticker) DO UPDATE SET name=excluded.name,exchange=COALESCE(excluded.exchange,stock_companies.exchange),updated_at=excluded.updated_at`).run(clean,name,exchange ?? null,now,now);
  const company = findCompany(db,clean)!;
  db.prepare(`INSERT INTO research_company_profiles(company_id,cik,updated_at) VALUES(?,?,?)
    ON CONFLICT(company_id) DO UPDATE SET cik=excluded.cik,updated_at=excluded.updated_at`).run(company.id,padCik(cik),now);
  db.prepare(`INSERT INTO stock_ticker_history(company_id,ticker,valid_from,event_type) SELECT ?,?,?,'LISTING'
    WHERE NOT EXISTS(SELECT 1 FROM stock_ticker_history WHERE company_id=?)`).run(company.id,clean,now,company.id);
  return company.id;
}

export function reconcileTickerChanges(db:Database.Database,cik:string,currentTickers:string[],now=new Date().toISOString()){
  const current=new Set(currentTickers.map(x=>x.toUpperCase())),rows=db.prepare(`SELECT c.id,c.ticker FROM research_company_profiles p JOIN stock_companies c ON c.id=p.company_id WHERE p.cik=?`).all(padCik(cik)) as {id:number;ticker:string}[];
  const stale=rows.filter(x=>!current.has(x.ticker)),missing=[...current].filter(t=>!rows.some(x=>x.ticker===t)&&!findCompany(db,t));
  if(stale.length!==1||missing.length!==1)return false;
  const row=stale[0],next=missing[0];db.prepare('UPDATE stock_companies SET ticker=?,updated_at=? WHERE id=?').run(next,now,row.id);db.prepare('UPDATE stock_ticker_history SET valid_to=?,event_type=? WHERE company_id=? AND valid_to IS NULL').run(now,'TICKER_CHANGE',row.id);db.prepare(`INSERT INTO stock_ticker_history(company_id,ticker,valid_from,event_type) VALUES(?,?,?,'TICKER_CHANGE')`).run(row.id,next,now);return true;
}

export function ingestSubmissions(db: Database.Database, companyId: number, submission: SecSubmission) {
  const recent = submission.filings?.recent ?? {}, forms = recent.form ?? [], now = new Date().toISOString();
  let created = 0;
  for (let i=0;i<forms.length;i++) {
    const form=forms[i]; if (!supportedForms.has(form)) continue;
    const accession=recent.accessionNumber?.[i]; const filingDate=recent.filingDate?.[i]; const doc=recent.primaryDocument?.[i];
    if (!accession || !filingDate || !doc) continue;
    const url=filingUrl(submission.cik,accession,doc);
    const sid=sourceId(db,{companyId,type:'SEC_FILING',externalId:accession,title:`${form} filed ${filingDate}`,url,publishedAt:filingDate,hash:hashText(accession)});
    const change=db.prepare(`INSERT OR IGNORE INTO research_filings(company_id,source_id,cik,form,filing_date,reporting_period,accession_number,source_url,collected_at,processing_status)
      VALUES(?,?,?,?,?,?,?,?,?,'COLLECTED')`).run(companyId,sid,padCik(submission.cik),form,filingDate,recent.reportDate?.[i] ?? null,accession,url,now).changes;
    created += change;
    if(form.startsWith('8-K')||form.startsWith('S-1'))db.prepare(`INSERT OR IGNORE INTO research_announcements(company_id,source_id,event_type,materiality,verified) VALUES(?,?,?,?,1)`).run(companyId,sid,form.startsWith('S-1')?'SHARE_ISSUANCE':'SEC_8_K',form.startsWith('S-1')?'HIGH':'MEDIUM');
  }
  return created;
}

export function ingestCompanyFacts(db: Database.Database, companyId: number, cik: string, payload: CompanyFacts) {
  const serialized=JSON.stringify(payload), hash=hashText(serialized), now=new Date().toISOString();
  const sid=sourceId(db,{companyId,type:'SEC_XBRL',externalId:`companyfacts-${padCik(cik)}`,title:`${payload.entityName} company facts`,url:`${SEC_BASE}/api/xbrl/companyfacts/CIK${padCik(cik)}.json`,hash});
  const facts=normalizeCompanyFacts(payload); let created=0;
  const insertPeriod=db.prepare(`INSERT INTO research_periods(company_id,fiscal_year,fiscal_period,period_start,period_end,form,filed_at,accession_number,source_id,is_restatement)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id,period_start,period_end,form,filed_at) DO UPDATE SET source_id=excluded.source_id`);
  for (const fact of facts) {
    const previous=db.prepare(`SELECT MAX(filed_at) AS filedAt FROM research_periods WHERE company_id=? AND period_end=? AND form=?`).get(companyId,fact.end,fact.form) as {filedAt:string|null};
    insertPeriod.run(companyId,fact.fiscalYear,fact.fiscalPeriod,fact.start,fact.end,fact.form,fact.filedAt,fact.accession,sid,previous.filedAt && previous.filedAt < fact.filedAt ? 1 : 0);
    const period=db.prepare(`SELECT id FROM research_periods WHERE company_id=? AND period_start IS ? AND period_end=? AND form=? AND filed_at=?`).get(companyId,fact.start,fact.end,fact.form,fact.filedAt) as {id:number};
    created += db.prepare(`INSERT INTO research_financial_metrics(period_id,metric,value,unit,source_id,context_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(period_id,metric) DO UPDATE SET value=excluded.value,unit=excluded.unit,source_id=excluded.source_id,context_json=excluded.context_json`)
      .run(period.id,fact.metric,fact.value,fact.unit,sid,JSON.stringify({frame:fact.frame,accession:fact.accession})).changes;
  }
  return { facts:facts.length, created, sourceId:sid, collectedAt:now };
}

export async function collectSecForTickers(db: Database.Database, tickers: string[], client = new SecClient()) {
  const map=await client.tickerMap(); const byTicker=new Map(Object.values(map).map(x=>[x.ticker.toUpperCase(),x]));
  let processed=0,created=0;
  for (const ticker of tickers.map(x=>x.toUpperCase())) {
    const item=byTicker.get(ticker); if (!item) continue;
    const companyId=upsertSecCompany(db,ticker,String(item.cik_str),item.title);
    const submissions=await client.submissions(String(item.cik_str));
    const facts=await client.companyFacts(String(item.cik_str));
    created += ingestSubmissions(db,companyId,submissions);
    created += ingestCompanyFacts(db,companyId,String(item.cik_str),facts).created;
    processed++;
  }
  return {processed,created};
}
