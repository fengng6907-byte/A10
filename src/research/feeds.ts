import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export type FeedItem={title:string;url:string;publishedAt:string|null;excerpt:string;externalId:string};
const decode=(s:string)=>s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
const tag=(block:string,names:string[])=>{for(const name of names){const m=block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i'));if(m)return decode(m[1]);}return ''};
export function parseFeed(xml:string):FeedItem[]{
  const blocks=xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi)??[];
  return blocks.map(block=>{
    const title=tag(block,['title']);
    let url=tag(block,['link']);
    if(!url){const m=block.match(/<link[^>]+href=["']([^"']+)["']/i);url=m?.[1]??'';}
    const publishedAt=tag(block,['pubDate','published','updated'])||null;
    const excerpt=tag(block,['description','summary','content']);
    const externalId=tag(block,['guid','id'])||url||createHash('sha256').update(title+'|'+publishedAt).digest('hex');
    return {title,url,publishedAt:publishedAt?new Date(publishedAt).toISOString():null,excerpt:excerpt.slice(0,600),externalId};
  }).filter(x=>x.title&&/^https?:\/\//i.test(x.url));
}

function safeRemoteUrl(raw:string){
  const url=new URL(raw); if(url.protocol!=='https:'&&url.protocol!=='http:')throw new Error('Feed URL must use HTTP(S)');
  const host=url.hostname.toLowerCase(); if(host==='localhost'||host.endsWith('.local')||/^127\.|^10\.|^192\.168\.|^169\.254\./.test(host))throw new Error('Private feed URLs are not allowed');
  return url.toString();
}
const eventType=(text:string)=>/guidance|outlook/i.test(text)?'GUIDANCE':/acqui|merger/i.test(text)?'ACQUISITION':/dividend/i.test(text)?'DIVIDEND':/appoint|resign|chief executive|cfo/i.test(text)?'MANAGEMENT_CHANGE':/offering|issuance|dilution/i.test(text)?'SHARE_ISSUANCE':/contract|award/i.test(text)?'SIGNIFICANT_CONTRACT':/product|launch/i.test(text)?'PRODUCT_ANNOUNCEMENT':/earnings|results/i.test(text)?'EARNINGS_RELEASE':'COMPANY_UPDATE';
const materiality=(text:string)=>/bankrupt|restatement|investigation|acqui|merger|guidance|offering|issuance|chief executive|cfo|earnings/i.test(text)?'HIGH':/contract|dividend|launch|results/i.test(text)?'MEDIUM':'LOW';
const opinion=(text:string)=>/\b(opinion|commentary|why i|could|might|should you|prediction)\b/i.test(text);

export type FeedConfig={ticker?:string;url:string;publisher:string};
export function parseFeedConfig(value:string|undefined):FeedConfig[]{if(!value)return[];const x=JSON.parse(value) as FeedConfig[];return x.filter(y=>y&&y.url&&y.publisher);}

export function ingestFeedItems(db:Database.Database, config:FeedConfig, items:FeedItem[], kind:'ANNOUNCEMENT'|'NEWS', knownTickers:string[]) {
  const ticker=config.ticker?.toUpperCase(); const company=ticker?db.prepare('SELECT id FROM stock_companies WHERE ticker=?').get(ticker) as {id:number}|undefined:undefined;
  let created=0;
  for(const item of items){
    const normalized=[item.title,item.url,item.publishedAt??'',item.excerpt].join('|'); const hash=createHash('sha256').update(normalized).digest('hex');
    const duplicate=db.prepare('SELECT id FROM research_sources WHERE content_hash=?').get(hash) as {id:number}|undefined;
    let sid=duplicate?.id;
    if(!sid){
      const row=db.prepare(`INSERT OR IGNORE INTO research_sources(company_id,source_type,external_id,title,publisher,url,published_at,collected_at,content_hash,excerpt,factuality,processing_status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'COLLECTED')`).run(company?.id??null,kind,`${config.publisher}:${item.externalId}`,item.title,config.publisher,item.url,item.publishedAt,new Date().toISOString(),hash,item.excerpt.slice(0,500),kind==='NEWS'&&opinion(item.title+' '+item.excerpt)?'OPINION':'PUBLISHER_REPORT');
      if(row.changes)created++;
      sid=(db.prepare('SELECT id FROM research_sources WHERE source_type=? AND external_id=?').get(kind,`${config.publisher}:${item.externalId}`) as {id:number}|undefined)?.id;
    }
    if(!sid)continue;
    const text=`${item.title} ${item.excerpt}`;
    if(kind==='ANNOUNCEMENT') db.prepare(`INSERT OR IGNORE INTO research_announcements(company_id,source_id,event_type,materiality,verified) VALUES(?,?,?,?,1)`).run(company?.id??null,sid,eventType(text),materiality(text));
    else {
      const linked=new Set<string>(); if(ticker)linked.add(ticker);
      for(const symbol of knownTickers)if(new RegExp(`(?:\\$|\\b)${symbol.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(text))linked.add(symbol);
      db.prepare(`INSERT OR IGNORE INTO research_news(source_id,tickers_json,materiality,is_opinion) VALUES(?,?,?,?)`).run(sid,JSON.stringify([...linked]),materiality(text),opinion(text)?1:0);
    }
  }
  return created;
}

export async function collectConfiguredFeeds(db:Database.Database, fetcher:typeof fetch=fetch){
  const known=(db.prepare('SELECT ticker FROM stock_companies').all() as {ticker:string}[]).map(x=>x.ticker);
  let processed=0,created=0;
  for(const [kind,configs] of [['ANNOUNCEMENT',parseFeedConfig(process.env.IR_FEEDS_JSON)],['NEWS',parseFeedConfig(process.env.NEWS_FEEDS_JSON)]] as const){
    for(const config of configs){const response=await fetcher(safeRemoteUrl(config.url),{headers:{'User-Agent':process.env.RESEARCH_USER_AGENT??'A10 research feed reader'}});if(!response.ok)throw new Error(`Feed failed (${response.status}): ${config.url}`);created+=ingestFeedItems(db,config,parseFeed(await response.text()),kind,known);processed++;}
  }
  return {processed,created};
}
