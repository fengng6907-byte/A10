import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ScoreComponent, ScoreResult, ScreeningInput } from './types';

const clamp=(n:number,min=0,max=1)=>Math.max(min,Math.min(max,n));
const growth=(current?:number|null,previous?:number|null)=>current==null||previous==null||previous===0?null:(current-previous)/Math.abs(previous);
function finalize(components:ScoreComponent[]):ScoreResult{
  const known=components.filter(x=>x.points!=null), knownWeight=known.reduce((n,x)=>n+x.weight,0), raw=known.reduce((n,x)=>n+(x.points??0),0);
  return {score:knownWeight?Math.round(raw/knownWeight*1000)/10:null,rawPoints:Math.round(raw*10)/10,completeness:Math.round(knownWeight*10)/10,components};
}
const component=(key:string,weight:number,ratio:number|null,explanation:string,evidenceIds:number[]=[]):ScoreComponent=>({key,weight,points:ratio==null?null:Math.round(clamp(ratio)*weight*10)/10,explanation,evidenceIds});

export function qualityScore(x:ScreeningInput):ScoreResult{
  const ev=x.financialEvidenceIds??[], debtRatio=x.cash==null||x.debt==null?null:x.debt===0?1:clamp(x.cash/x.debt/2);
  const profitability=x.netIncome==null||x.operatingCashFlow==null||x.freeCashFlow==null||x.revenue==null?null:
    ([x.netIncome>0,x.operatingCashFlow>0,x.freeCashFlow>0].filter(Boolean).length/3*.75+clamp(x.netIncome/x.revenue/.2)*.25);
  const yoy=growth(x.revenue,x.yearAgoRevenue), sequential=growth(x.revenue,x.previousRevenue);
  const growthRatio=yoy==null?null:clamp((yoy+.05)/.30)*.75+(sequential==null?.25:clamp((sequential+.05)/.15)*.25);
  let valuation:number|null=null,valuationText='Market capitalization and revenue or earnings are required.';
  if(x.marketCap!=null&&x.revenue!=null&&x.revenue>0){const ps=x.marketCap/x.revenue;let pe:number|null=x.netIncome&&x.netIncome>0?x.marketCap/x.netIncome:null;valuation=clamp((12-ps)/10)*(pe==null?1:.55)+ (pe==null?0:clamp((45-pe)/35)*.45);valuationText=`P/S ${ps.toFixed(2)}${pe==null?'; positive P/E unavailable':`; P/E ${pe.toFixed(1)}`}.`;}
  const q=x.qualitative?.competitiveStrength;
  return finalize([
    component('financial_health',25,debtRatio,debtRatio==null?'Cash and debt must both be reported.':`Cash/debt coverage is ${x.debt===0?'debt free':(x.cash!/x.debt!).toFixed(2)+'×'}.`,ev),
    component('profitability_cash_flow',25,profitability,profitability==null?'Revenue, net income, operating cash flow and free cash flow are required.':'Positive earnings and cash flow plus net margin determine this component.',ev),
    component('growth',20,growthRatio,yoy==null?'A comparable prior-year revenue period is required.':`Revenue growth is ${(yoy*100).toFixed(1)}% year over year${sequential==null?'':` and ${(sequential*100).toFixed(1)}% sequentially`}.`,ev),
    component('valuation',20,valuation,valuationText,ev),
    component('competitive_strength',10,q?clamp(q.score/100):null,q?.assumption??'No cited qualitative competitive-strength assessment is available.',q?.evidenceIds??[]),
  ]);
}

export function growthScore(x:ScreeningInput):ScoreResult{
  const ev=x.financialEvidenceIds??[], yoy=growth(x.revenue,x.yearAgoRevenue), q=x.qualitative;
  let runway:number|null=null,runwayText='Cash and free cash flow are required.';
  if(x.cash!=null&&x.freeCashFlow!=null){if(x.freeCashFlow>=0){runway=1;runwayText='Free cash flow is non-negative.';}else{const years=x.cash/Math.abs(x.freeCashFlow);runway=clamp(years/3);runwayText=`Cash runway is approximately ${years.toFixed(1)} periods at the latest burn rate; period comparability must be reviewed.`;}}
  let valuation:number|null=null,valuationText='Market capitalization and revenue are required.';
  if(x.marketCap!=null&&x.revenue!=null&&x.revenue>0){const ps=x.marketCap/x.revenue;valuation=clamp((20-ps)/18);valuationText=`P/S is ${ps.toFixed(2)}; the formula awards full points near 2× and zero at 20× or above.`;}
  return finalize([
    component('revenue_growth',25,yoy==null?null:clamp((yoy+.05)/.55),yoy==null?'A comparable prior-year revenue period is required.':`Revenue growth is ${(yoy*100).toFixed(1)}% year over year.`,ev),
    component('market_opportunity',20,q?.marketOpportunity?clamp(q.marketOpportunity.score/100):null,q?.marketOpportunity?.assumption??'No cited market-opportunity assessment is available.',q?.marketOpportunity?.evidenceIds??[]),
    component('financial_runway',20,runway,runwayText,ev),
    component('competitive_differentiation',15,q?.differentiation?clamp(q.differentiation.score/100):null,q?.differentiation?.assumption??'No cited differentiation assessment is available.',q?.differentiation?.evidenceIds??[]),
    component('valuation',15,valuation,valuationText,ev),
    component('execution_record',5,q?.execution?clamp(q.execution.score/100):null,q?.execution?.assumption??'No cited execution assessment is available.',q?.execution?.evidenceIds??[]),
  ]);
}

function latestMetrics(db:Database.Database,companyId:number){
  const rows=db.prepare(`SELECT p.id AS periodId,p.period_start AS start,p.period_end AS end,p.fiscal_year AS fiscalYear,p.fiscal_period AS fiscalPeriod,p.form,m.metric,m.value,m.source_id AS sourceId
    FROM research_periods p JOIN research_financial_metrics m ON m.period_id=p.id WHERE p.company_id=?
    ORDER BY p.period_end DESC,p.filed_at DESC`).all(companyId) as {periodId:number;start:string|null;end:string;fiscalYear:number|null;fiscalPeriod:string|null;form:string;metric:string;value:number;sourceId:number|null}[];
  const duration=(r:typeof rows[number])=>r.start?(Date.parse(r.end)-Date.parse(r.start))/86400000:0;
  const quarterRows=rows.filter(r=>r.form.startsWith('10-Q')&&(!r.start||duration(r)<=140));
  const quarterEnds=[...new Set(quarterRows.map(r=>r.end))].sort().reverse();
  const metric=(name:string,end?:string)=>rows.find(r=>r.metric===name&&(!end||r.end===end)&&(!r.start||(r.form.startsWith('10-Q')?duration(r)<=140:duration(r)>=250)));
  const latestEnd=quarterEnds[0]??rows[0]?.end,previousEnd=quarterEnds[1];
  const latestRevenue=metric('revenue',latestEnd),previousRevenue=metric('revenue',previousEnd);
  const yearAgo=latestRevenue?quarterRows.find(r=>r.metric==='revenue'&&r.fiscalYear===(latestRevenue.fiscalYear??0)-1&&r.fiscalPeriod===latestRevenue.fiscalPeriod):undefined;
  const value=(n:string)=>metric(n,latestEnd)?.value??metric(n)?.value??null;
  return {latestEnd,revenue:latestRevenue?.value??null,previousRevenue:previousRevenue?.value??null,yearAgoRevenue:yearAgo?.value??null,
    netIncome:value('net_income'),operatingIncome:value('operating_income'),operatingCashFlow:value('operating_cash_flow'),freeCashFlow:value('free_cash_flow'),
    grossProfit:value('gross_profit'),cash:value('cash_and_equivalents'),debt:value('debt'),outstandingShares:value('outstanding_shares'),eps:value('eps_diluted'),
    evidenceIds:[...new Set(rows.slice(0,40).map(r=>r.sourceId).filter((n):n is number=>n!=null))]};
}

export function buildScreeningInput(db:Database.Database,companyId:number):ScreeningInput{
  const company=db.prepare(`SELECT c.id,c.ticker,c.name,c.sector,p.industry,p.listing_date AS listingDate,p.market_cap AS marketCap FROM stock_companies c LEFT JOIN research_company_profiles p ON p.company_id=c.id WHERE c.id=?`).get(companyId) as {id:number;ticker:string;name:string;sector:string|null;industry:string|null;listingDate:string|null;marketCap:number|null};
  const m=latestMetrics(db,companyId);
  const qualitativeRows=db.prepare(`SELECT a.event_type AS eventType,s.id FROM research_announcements a JOIN research_sources s ON s.id=a.source_id WHERE a.company_id=? AND a.verified=1 ORDER BY s.published_at DESC LIMIT 20`).all(companyId) as {eventType:string;id:number}[];
  const product=qualitativeRows.filter(r=>['PRODUCT_ANNOUNCEMENT','SIGNIFICANT_CONTRACT'].includes(r.eventType));
  const execution=qualitativeRows.filter(r=>['EARNINGS_RELEASE','SIGNIFICANT_CONTRACT'].includes(r.eventType));
  return {companyId,ticker:company.ticker,company:company.name,sector:company.sector,industry:company.industry,listingDate:company.listingDate,marketCap:company.marketCap,...m,
    financialEvidenceIds:m.evidenceIds,qualitative:{
      competitiveStrength:product.length?{score:55,evidenceIds:product.map(r=>r.id),assumption:'Verified product or contract announcements provide limited evidence of competitive strength; no market-share inference is made.'}:undefined,
      differentiation:product.length?{score:50,evidenceIds:product.map(r=>r.id),assumption:'Official product or contract disclosures provide limited differentiation evidence; durability is unverified.'}:undefined,
      execution:execution.length?{score:60,evidenceIds:execution.map(r=>r.id),assumption:'Recent official earnings or contract disclosures are used as execution evidence.'}:undefined,
    }};
}

export function runDiscovery(db:Database.Database,limit=100,now=new Date()){
  const companies=db.prepare(`SELECT c.id FROM stock_companies c WHERE EXISTS(SELECT 1 FROM research_periods p WHERE p.company_id=c.id) ORDER BY c.id LIMIT ?`).all(limit) as {id:number}[];
  const evaluations:{companyId:number;category:string;quality:ScoreResult;growth:ScoreResult;input:ScreeningInput;inputHash:string;reasons:string[];risks:string[]}[]=[];
  for(const c of companies){const input=buildScreeningInput(db,c.id),quality=qualityScore(input),growthResult=growthScore(input);
    const isRecent=Boolean(input.listingDate&&Date.parse(input.listingDate)>=now.getTime()-36*31*86400000)||Boolean(db.prepare(`SELECT 1 FROM research_filings WHERE company_id=? AND form LIKE 'S-1%' AND filing_date>=?`).get(c.id,new Date(now.getTime()-36*31*86400000).toISOString().slice(0,10)));
    const cats:string[]=[];if((quality.score??0)>=65&&quality.completeness>=60)cats.push('QUALITY_COMPOUNDER');if((growthResult.score??0)>=65&&growthResult.completeness>=55)cats.push('EMERGING_GROWTH');if(isRecent)cats.push('RECENT_IPO');
    if(!cats.length)continue; const hash=createHash('sha256').update(JSON.stringify({input,quality,growthResult})).digest('hex');
    const reasons=[quality.score!=null?`Quality score ${quality.score.toFixed(1)} at ${quality.completeness.toFixed(0)}% completeness.`:'Quality score unavailable.',growthResult.score!=null?`Growth score ${growthResult.score.toFixed(1)} at ${growthResult.completeness.toFixed(0)}% completeness.`:'Growth score unavailable.'];
    const risks=[...(input.debt!=null&&input.cash!=null&&input.debt>input.cash?['Debt exceeds cash.']:[]),...(input.freeCashFlow!=null&&input.freeCashFlow<0?['Free cash flow is negative.']:[]),...(quality.completeness<80||growthResult.completeness<80?['Screening data is incomplete.']:[])];
    for(const category of cats)evaluations.push({companyId:c.id,category,quality,growth:growthResult,input,inputHash:hash,reasons,risks});
  }
  const byCategory=new Map<string,typeof evaluations>();for(const e of evaluations){const arr=byCategory.get(e.category)??[];arr.push(e);byCategory.set(e.category,arr);}
  let created=0;
  db.transaction(()=>{for(const [category,rows] of byCategory){rows.sort((a,b)=>((b.category==='QUALITY_COMPOUNDER'?b.quality.score:b.growth.score)??-1)-((a.category==='QUALITY_COMPOUNDER'?a.quality.score:a.growth.score)??-1));
    rows.forEach((e,i)=>{const prior=db.prepare(`SELECT rank FROM research_screenings WHERE company_id=? AND category=? AND is_current=1 ORDER BY evaluated_at DESC LIMIT 1`).get(e.companyId,category) as {rank:number|null}|undefined;
      db.prepare('UPDATE research_screenings SET is_current=0 WHERE company_id=? AND category=?').run(e.companyId,category);
      const rowChanges=db.prepare(`INSERT OR IGNORE INTO research_screenings(company_id,category,quality_score,growth_score,completeness,rank,previous_rank,reasons_json,risks_json,components_json,input_hash,evaluated_at,is_current)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(e.companyId,category,e.quality.score,e.growth.score,category==='QUALITY_COMPOUNDER'?e.quality.completeness:category==='EMERGING_GROWTH'?e.growth.completeness:Math.max(e.quality.completeness,e.growth.completeness),i+1,prior?.rank??null,JSON.stringify(e.reasons),JSON.stringify(e.risks),JSON.stringify({quality:e.quality.components,growth:e.growth.components}),e.inputHash,now.toISOString()).changes;
      created+=rowChanges;
      if(!rowChanges)db.prepare('UPDATE research_screenings SET is_current=1,rank=?,previous_rank=? WHERE company_id=? AND category=? AND input_hash=?').run(i+1,prior?.rank??null,e.companyId,category,e.inputHash);
      const screening=db.prepare('SELECT id FROM research_screenings WHERE company_id=? AND category=? AND input_hash=?').get(e.companyId,category,e.inputHash) as {id:number};
      if(prior?.rank==null||Math.abs(prior.rank-(i+1))>=3){const changeType=prior?.rank==null?'NEW_QUALIFICATION':prior.rank>i+1?'RANK_IMPROVED':'RANK_WEAKENED',fingerprint=createHash('sha256').update([e.companyId,category,changeType,prior?.rank??'',i+1,now.toISOString().slice(0,10)].join('|')).digest('hex');db.prepare(`INSERT OR IGNORE INTO research_ranking_changes(company_id,category,change_type,previous_rank,current_rank,screening_id,fingerprint,detected_at) VALUES(?,?,?,?,?,?,?,?)`).run(e.companyId,category,changeType,prior?.rank??null,i+1,screening.id,fingerprint,now.toISOString());}
    });}}
  )();
  return {processed:companies.length,qualified:evaluations.length,created};
}
