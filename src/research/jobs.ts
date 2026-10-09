import type Database from 'better-sqlite3';
import { researchDb,finishRun,startRun } from './store';
import { SecClient,ingestCompanyFacts,ingestSubmissions,reconcileTickerChanges,upsertSecCompany } from './sec';
import { collectConfiguredFeeds } from './feeds';
import { detectAndStoreFinancialChanges } from './changes';
import { runDiscovery } from './scoring';
import { generateResearchReport } from './research';
import { generateResearchNotifications,processNotificationDeliveries } from './notifications';
import { generateDailyBriefing } from './briefing';
import { classifyMaterialChanges } from './materiality';
import { applyVerifiedIpoMetadata } from './universe';

export type ResearchTask='financials'|'discover'|'research'|'alerts'|'briefing';
export type JobOptions={tickers?:string[];limit?:number};

async function guarded<T>(db:Database.Database,kind:string,fn:(id:number)=>Promise<T>|T){
  const cutoff=new Date(Date.now()-15*60000).toISOString();
  const active=db.prepare(`SELECT id FROM research_collection_runs WHERE kind=? AND status='RUNNING' AND started_at>=? LIMIT 1`).get(kind,cutoff) as {id:number}|undefined;
  if(active)return {skipped:true,reason:'A recent batch is already running',runId:active.id};
  db.prepare(`UPDATE research_collection_runs SET status='FAILED',finished_at=?,error='Stale run lock expired' WHERE kind=? AND status='RUNNING' AND started_at<?`).run(new Date().toISOString(),kind,cutoff);
  const id=startRun(db,kind);
  try{const value=await fn(id);return {skipped:false,runId:id,...(value as object)};}catch(error){finishRun(db,id,'FAILED',0,0,error instanceof Error?error.message:String(error));throw error;}
}

async function financials(db:Database.Database,options:JobOptions){
  return guarded(db,'FINANCIALS',async id=>{
    const client=new SecClient(),map=await client.tickerMap(),items=Object.values(map);
    for(const item of items)upsertSecCompany(db,item.ticker,String(item.cik_str),item.title);
    let tickers=options.tickers?.map(x=>x.toUpperCase());
    if(!tickers?.length){
      const limit=Math.max(1,Math.min(options.limit??Number(process.env.SEC_BATCH_SIZE??5),25));
      const watchLimit=Math.ceil(limit/2),watch=db.prepare(`SELECT c.ticker FROM stock_watchlist w JOIN stock_companies c ON c.id=w.company_id ORDER BY COALESCE((SELECT MAX(filed_at) FROM research_periods p WHERE p.company_id=c.id),'') ASC,c.ticker LIMIT ?`).all(watchLimit) as {ticker:string}[];
      const remaining=Math.max(0,limit-watch.length),broad=remaining?db.prepare(`SELECT c.ticker FROM stock_companies c JOIN research_company_profiles p ON p.company_id=c.id WHERE NOT EXISTS(SELECT 1 FROM stock_watchlist w WHERE w.company_id=c.id) ORDER BY CASE WHEN EXISTS(SELECT 1 FROM research_periods rp WHERE rp.company_id=c.id) THEN 1 ELSE 0 END,COALESCE((SELECT MAX(filed_at) FROM research_periods rp WHERE rp.company_id=c.id),''),c.id LIMIT ?`).all(remaining) as {ticker:string}[]:[];
      tickers=[...watch,...broad].map(x=>x.ticker);
    }
    let processed=0,created=0;
    const byTicker=new Map(items.map(x=>[x.ticker.toUpperCase(),x]));
    for(const ticker of tickers){const item=byTicker.get(ticker);if(!item)continue;const companyId=upsertSecCompany(db,ticker,String(item.cik_str),item.title);const sub=await client.submissions(String(item.cik_str));const facts=await client.companyFacts(String(item.cik_str));reconcileTickerChanges(db,String(item.cik_str),sub.tickers??[ticker]);db.prepare(`UPDATE research_company_profiles SET industry=COALESCE(?,industry),sic=COALESCE(?,sic),description=COALESCE(?,description),updated_at=? WHERE company_id=?`).run(sub.sicDescription??null,sub.sic??null,sub.description??null,new Date().toISOString(),companyId);db.prepare(`UPDATE stock_companies SET exchange=COALESCE(?,exchange),updated_at=? WHERE id=?`).run(sub.exchanges?.[sub.tickers?.indexOf(ticker)??0]??sub.exchanges?.[0]??null,new Date().toISOString(),companyId);created+=ingestSubmissions(db,companyId,sub);created+=ingestCompanyFacts(db,companyId,String(item.cik_str),facts).created;processed++;}
    const feeds=await collectConfiguredFeeds(db);created+=feeds.created;processed+=feeds.processed;created+=applyVerifiedIpoMetadata(db);created+=detectAndStoreFinancialChanges(db);
    db.prepare(`UPDATE research_company_profiles SET market_cap=(SELECT q.price*m.value FROM stock_quotes q JOIN research_periods p ON p.company_id=research_company_profiles.company_id JOIN research_financial_metrics m ON m.period_id=p.id AND m.metric='outstanding_shares' WHERE q.company_id=research_company_profiles.company_id ORDER BY q.quote_at DESC,p.period_end DESC LIMIT 1),updated_at=? WHERE EXISTS(SELECT 1 FROM stock_quotes q WHERE q.company_id=research_company_profiles.company_id)`).run(new Date().toISOString());
    finishRun(db,id,'DONE',processed,created);return {processed,created,tickers};
  });
}

export async function runResearchTask(task:ResearchTask,options:JobOptions={},db=researchDb()){
  if(task==='financials')return financials(db,options);
  if(task==='discover')return guarded(db,'DISCOVERY',id=>{const result=runDiscovery(db,options.limit??250);finishRun(db,id,'DONE',result.processed,result.created);return result;});
  if(task==='research')return guarded(db,'RESEARCH',async id=>{let companies:{id:number;ticker:string}[]=[];if(options.tickers?.length){companies=db.prepare(`SELECT id,ticker FROM stock_companies WHERE ticker IN (${options.tickers.map(()=>'?').join(',')})`).all(...options.tickers.map(x=>x.toUpperCase())) as typeof companies;}else companies=db.prepare(`SELECT DISTINCT c.id,c.ticker FROM research_screenings s JOIN stock_companies c ON c.id=s.company_id WHERE s.is_current=1 AND s.completeness>=55 ORDER BY COALESCE(s.quality_score,s.growth_score) DESC LIMIT ?`).all(options.limit??3) as typeof companies;let created=0;for(const c of companies){const result=await generateResearchReport(db,c.id);if(!result.cached)created++;}finishRun(db,id,'DONE',companies.length,created);return{processed:companies.length,created,tickers:companies.map(x=>x.ticker)};});
  if(task==='alerts')return guarded(db,'ALERTS',async id=>{const classification=await classifyMaterialChanges(db);const created=generateResearchNotifications(db);const delivery=await processNotificationDeliveries(db);finishRun(db,id,'DONE',delivery.processed+classification.processed,created+delivery.delivered+classification.created);return{classification,created,delivery};});
  return guarded(db,'BRIEFING',id=>{const briefing=generateDailyBriefing(db);finishRun(db,id,'DONE',1,1);return{briefing};});
}
