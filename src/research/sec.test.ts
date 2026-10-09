import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { normalizeCompanyFacts } from './sec';
import { detectChanges,type PeriodMetric } from './changes';
import { ensureStockSchema,seedWatchlist } from '@/stocks/store';
import { ensureResearchSchema } from './store';
import { parseFeed,ingestFeedItems as ingestFeed } from './feeds';

test('SEC XBRL fixture normalizes latest amendment and derives free cash flow',()=>{
  const payload:any={cik:789019,entityName:'MICROSOFT CORP',facts:{'us-gaap':{
    RevenueFromContractWithCustomerExcludingAssessedTax:{units:{USD:[{val:62000000000,start:'2025-07-01',end:'2025-09-30',fy:2026,fp:'Q1',form:'10-Q',filed:'2025-10-29',accn:'0001'},{val:62500000000,start:'2025-07-01',end:'2025-09-30',fy:2026,fp:'Q1',form:'10-Q/A',filed:'2025-11-01',accn:'0002'}]}},
    NetCashProvidedByUsedInOperatingActivities:{units:{USD:[{val:31000000000,start:'2025-07-01',end:'2025-09-30',fy:2026,fp:'Q1',form:'10-Q',filed:'2025-10-29'}]}},
    PaymentsToAcquirePropertyPlantAndEquipment:{units:{USD:[{val:12000000000,start:'2025-07-01',end:'2025-09-30',fy:2026,fp:'Q1',form:'10-Q',filed:'2025-10-29'}]}}
  }}};
  const facts=normalizeCompanyFacts(payload);
  assert.ok(facts.some(x=>x.metric==='revenue'&&x.value===62500000000&&x.form==='10-Q/A'));
  assert.equal(facts.find(x=>x.metric==='free_cash_flow')?.value,19000000000);
});

test('change detection separates quarter-over-quarter, year-over-year and restatements',()=>{
  const f=(id:number,fy:number,fp:string,end:string,value:number,filedAt='2026-05-01'):PeriodMetric=>({periodId:id,fiscalYear:fy,fiscalPeriod:fp,start:new Date(Date.parse(end)-90*86400000).toISOString().slice(0,10),end,form:'10-Q',filedAt,metric:'revenue',value,sourceId:id});
  const changes=detectChanges(1,[f(1,2025,'Q1','2025-03-31',100),f(2,2025,'Q2','2025-06-30',110),f(3,2026,'Q1','2026-03-31',130),f(4,2026,'Q1','2026-03-31',132,'2026-05-10')]);
  assert.ok(changes.some(x=>x.comparison==='QOQ'&&x.oldValue===110&&x.newValue===132));
  assert.ok(changes.some(x=>x.comparison==='YOY'&&x.oldValue===100&&x.newValue===132));
  assert.ok(changes.some(x=>x.comparison==='RESTATEMENT'&&x.oldValue===130&&x.newValue===132));
});

test('RSS ingestion stores one concise, classified article when a feed repeats it',()=>{
  const db=new Database(':memory:');ensureStockSchema(db);seedWatchlist(db);ensureResearchSchema(db);
  const xml=`<rss><channel><item><title>Microsoft raises forward guidance</title><link>https://example.com/ir/1</link><guid>release-1</guid><pubDate>Thu, 08 Oct 2026 12:00:00 GMT</pubDate><description>Official quarterly outlook update.</description></item></channel></rss>`;
  const items=parseFeed(xml);assert.equal(items.length,1);
  assert.equal(ingestFeed(db,{ticker:'MSFT',url:'https://example.com/feed',publisher:'Microsoft IR'},items,'ANNOUNCEMENT',['MSFT']),1);
  assert.equal(ingestFeed(db,{ticker:'MSFT',url:'https://example.com/feed',publisher:'Microsoft IR'},items,'ANNOUNCEMENT',['MSFT']),0);
  assert.equal((db.prepare('SELECT event_type FROM research_announcements').get() as any).event_type,'GUIDANCE');db.close();
});
