import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureStockSchema,seedWatchlist } from '@/stocks/store';
import { ensureResearchSchema } from './store';
import { generateResearchReport,validateResearchOutput,type AIResearchProvider } from './research';
import { createNotification,processNotificationDeliveries,type EmailAdapter } from './notifications';
import { buildDailyBriefing } from './briefing';

const output=(companyId:number,sourceId:number)=>({companyId,executiveSummary:[{text:'The filing supplies verified operating evidence.',evidenceIds:[sourceId]}],businessSummary:[],businessModel:[],financialPerformance:[],financialStrengths:[],financialWeaknesses:[],growthCatalysts:[],competitiveAdvantages:[],valuationObservations:[],bullCase:[],baseCase:[],bearCase:[],risks:[],keyEvents:[],conclusion:[{text:'More research is required.',evidenceIds:[sourceId]}],assessment:'INSUFFICIENT DATA',missingInformation:['Peer valuation data'],dataCompletenessConfidence:'LOW'});
function fixture(){const db=new Database(':memory:');ensureStockSchema(db);seedWatchlist(db);ensureResearchSchema(db);const c=db.prepare("SELECT id FROM stock_companies WHERE ticker='MSFT'").get() as {id:number};const sid=Number(db.prepare(`INSERT INTO research_sources(company_id,source_type,external_id,title,publisher,url,published_at,collected_at,content_hash,excerpt) VALUES(?,'SEC_XBRL','facts','Facts','SEC','https://sec.gov/facts','2026-10-01','2026-10-01','h','Official facts')`).run(c.id).lastInsertRowid);return{db,companyId:c.id,sourceId:sid};}

test('research validation rejects nonexistent evidence IDs',()=>{assert.throws(()=>validateResearchOutput(output(1,999),1,[1]),/Unsupported source ID/);});
test('research generation records invalid output, accepts supported claims and caches unchanged evidence',async()=>{
  const {db,companyId,sourceId}=fixture();let calls=0;const provider:AIResearchProvider={async generate(){calls++;return{output:calls===1?output(companyId,999):output(companyId,sourceId),model:'fixture-model',promptTokens:100,completionTokens:50};}};
  await assert.rejects(generateResearchReport(db,companyId,provider),/Unsupported source ID/);
  const good=await generateResearchReport(db,companyId,provider);assert.equal(good.cached,false);
  const cached=await generateResearchReport(db,companyId,provider);assert.equal(cached.cached,true);assert.equal(calls,2);
  const row=db.prepare('SELECT generation_status,model,prompt_tokens FROM research_reports').get() as any;assert.equal(row.generation_status,'DONE');assert.equal(row.model,'fixture-model');db.close();
});
test('notifications deduplicate and failed email delivery is retained for retry',async()=>{
  const {db,companyId}=fixture();db.prepare("UPDATE research_notification_preferences SET email_enabled=1,email_address='owner@example.com',cooldown_minutes=0 WHERE id=1").run();
  const input={companyId,category:'MATERIAL_INVESTMENT_RISK' as const,priority:'CRITICAL' as const,eventAt:'2026-10-09T00:00:00Z',title:'Debt increased',whyItMatters:'Balance-sheet risk increased.',risks:'Refinancing risk.',evidenceIds:[],targetUrl:'/stocks/research/MSFT',dedupeKey:'same',groupKey:'risk:msft'};
  assert.ok(createNotification(db,input,new Date('2026-10-09T00:00:00Z')));assert.equal(createNotification(db,input,new Date('2026-10-09T00:01:00Z')),null);
  const adapter:EmailAdapter={async send(){throw new Error('fixture outage');}};const result=await processNotificationDeliveries(db,adapter,new Date('2026-10-09T00:02:00Z'));assert.equal(result.failed,1);assert.equal((db.prepare("SELECT status FROM research_notification_deliveries WHERE channel='EMAIL'").get() as any).status,'RETRY');db.close();
});
test('briefing states clearly when there are no meaningful discoveries',()=>{const {db}=fixture();const brief=buildDailyBriefing(db,new Date('2026-10-09T00:00:00Z'));assert.equal(brief.noMeaningfulDiscoveries,true);assert.equal(brief.qualityDiscoveries.length,0);db.close();});
