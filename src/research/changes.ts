import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export type PeriodMetric = { periodId: number; fiscalYear: number|null; fiscalPeriod: string|null; start:string|null; end: string; form: string; filedAt: string; metric: string; value: number; sourceId: number|null };
export type FinancialChange = { companyId: number; metric: string; comparison: 'QOQ'|'YOY'|'RESTATEMENT'; fromPeriodId: number; toPeriodId: number; oldValue: number; newValue: number; absoluteChange: number; percentChange: number|null; direction: string; materiality: string; evidenceIds: number[]; fingerprint: string };

const lowerIsBetter = new Set(['debt','capital_expenditure']);
const threshold: Record<string,number> = { revenue:.05,net_income:.1,eps_diluted:.1,gross_profit:.05,operating_income:.1,operating_cash_flow:.15,capital_expenditure:.2,free_cash_flow:.15,cash_and_equivalents:.15,debt:.1,outstanding_shares:.02 };

export function compareMetric(companyId:number, current:PeriodMetric, previous:PeriodMetric, comparison:FinancialChange['comparison']): FinancialChange {
  const absolute=current.value-previous.value;
  const percent=previous.value === 0 ? null : absolute/Math.abs(previous.value);
  const favorable=lowerIsBetter.has(current.metric) ? absolute < 0 : absolute > 0;
  const magnitude=percent == null ? Math.abs(absolute) : Math.abs(percent);
  const required=threshold[current.metric] ?? .1;
  const materiality=magnitude >= required*2 ? 'HIGH' : magnitude >= required ? 'MEDIUM' : 'LOW';
  const fingerprint=createHash('sha256').update([companyId,current.metric,comparison,previous.periodId,current.periodId,previous.value,current.value].join('|')).digest('hex');
  return { companyId,metric:current.metric,comparison,fromPeriodId:previous.periodId,toPeriodId:current.periodId,oldValue:previous.value,newValue:current.value,
    absoluteChange:absolute,percentChange:percent,direction:absolute===0?'UNCHANGED':favorable?'IMPROVING':'WEAKENING',materiality,
    evidenceIds:[previous.sourceId,current.sourceId].filter((x):x is number=>x!=null),fingerprint };
}

export function detectChanges(companyId:number, facts:PeriodMetric[]): FinancialChange[] {
  facts=facts.filter(f=>{
    if(!f.start)return true;
    const days=(Date.parse(f.end)-Date.parse(f.start))/86400000;
    return f.form.startsWith('10-Q')?days<=140:f.form.startsWith('10-K')?days>=250:true;
  });
  const latest=new Map<string,PeriodMetric>();
  for (const fact of facts) {
    const key=[fact.end,fact.form,fact.metric].join('|');
    const prior=latest.get(key); if (!prior || fact.filedAt>prior.filedAt) latest.set(key,fact);
  }
  const rows=[...latest.values()], changes:FinancialChange[]=[];
  for (const current of rows) {
    let previous:PeriodMetric|undefined, comparison:FinancialChange['comparison']='YOY';
    if (current.form.startsWith('10-Q')) {
      previous=rows.filter(x=>x.metric===current.metric&&x.form.startsWith('10-Q')&&x.end<current.end).sort((a,b)=>b.end.localeCompare(a.end))[0]; comparison='QOQ';
      if (previous) changes.push(compareMetric(companyId,current,previous,comparison));
      previous=rows.find(x=>x.metric===current.metric&&x.form.startsWith('10-Q')&&x.fiscalYear===((current.fiscalYear??0)-1)&&x.fiscalPeriod===current.fiscalPeriod);
      if (previous) changes.push(compareMetric(companyId,current,previous,'YOY'));
    } else if (current.form.startsWith('10-K')) {
      previous=rows.find(x=>x.metric===current.metric&&x.form.startsWith('10-K')&&x.fiscalYear===((current.fiscalYear??0)-1));
      if (previous) changes.push(compareMetric(companyId,current,previous,'YOY'));
    }
    const restated=facts.filter(x=>x.metric===current.metric&&x.end===current.end&&x.form===current.form&&x.filedAt<current.filedAt).sort((a,b)=>b.filedAt.localeCompare(a.filedAt))[0];
    if (restated && restated.value!==current.value) changes.push(compareMetric(companyId,current,restated,'RESTATEMENT'));
  }
  return [...new Map(changes.map(c=>[c.fingerprint,c])).values()];
}

export function detectAndStoreFinancialChanges(db:Database.Database, companyId?:number) {
  const companies=companyId?[{id:companyId}]:db.prepare('SELECT DISTINCT company_id AS id FROM research_periods').all() as {id:number}[];
  let created=0;
  for (const company of companies) {
    const facts=db.prepare(`SELECT p.id AS periodId,p.fiscal_year AS fiscalYear,p.fiscal_period AS fiscalPeriod,p.period_start AS start,p.period_end AS end,p.form,p.filed_at AS filedAt,
      m.metric,m.value,m.source_id AS sourceId FROM research_periods p JOIN research_financial_metrics m ON m.period_id=p.id WHERE p.company_id=?`).all(company.id) as PeriodMetric[];
    for (const c of detectChanges(company.id,facts)) {
      created += db.prepare(`INSERT OR IGNORE INTO research_financial_changes(company_id,metric,comparison,from_period_id,to_period_id,old_value,new_value,absolute_change,percent_change,direction,materiality,evidence_ids_json,fingerprint,detected_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.companyId,c.metric,c.comparison,c.fromPeriodId,c.toPeriodId,c.oldValue,c.newValue,c.absoluteChange,c.percentChange,c.direction,c.materiality,JSON.stringify(c.evidenceIds),c.fingerprint,new Date().toISOString()).changes;
    }
  }
  return created;
}
