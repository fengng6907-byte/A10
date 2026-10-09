import { NextResponse } from 'next/server';
import { jobRows, listEvents, listRules, listWatchlist, stockDb } from '@/stocks/store';
import { ensureMonitorJob, monitorCadenceMinutes } from '@/stocks/jobs';
import { marketSession } from '@/stocks/session';
import { connectionStatus } from '@/stocks/moomoo-auth';
import { quoteFreshness } from '@/stocks/moomoo';
import { providerConfiguration } from '@/stocks/provider';

export const dynamic = 'force-dynamic';
export async function GET() {
  const db = stockDb(); ensureMonitorJob(db);
  const storedWatchlist = listWatchlist(db) as Array<Record<string, unknown> & { quoteAt: string | null; receivedAt: string | null; provider: string | null; quality: string | null }>;
  const provider = providerConfiguration();
  const heartbeat = db.prepare("SELECT value FROM stock_meta WHERE key='worker_last_seen'").get() as { value: string } | undefined;
  const workerProvider = db.prepare("SELECT value FROM stock_meta WHERE key='worker_provider'").get() as { value: string } | undefined;
  const lastRun = db.prepare("SELECT started_at AS startedAt,finished_at AS finishedAt,status,items_processed AS itemsProcessed,error FROM agent_job_runs ORDER BY id DESC LIMIT 1").get() ?? null;
  const runs = db.prepare("SELECT id,started_at AS startedAt,finished_at AS finishedAt,status,items_processed AS itemsProcessed,error FROM agent_job_runs ORDER BY id DESC LIMIT 12").all();
  const providerHealth = db.prepare("SELECT provider,requested_at AS requestedAt,status,error FROM stock_provider_requests ORDER BY id DESC LIMIT 1").get() ?? null;
  const lastSuccess = db.prepare("SELECT finished_at AS at FROM agent_job_runs WHERE status='DONE' ORDER BY id DESC LIMIT 1").get() as { at: string } | undefined;
  const workerOnline = !!heartbeat && Date.now() - Date.parse(heartbeat.value) < 45_000 && workerProvider?.value === provider.selected;
  const moomoo = connectionStatus(db);
  const now = new Date();
  const watchlist = storedWatchlist.map(item => {
    const quality = item.provider === 'MOOMOO' && moomoo.entitlement === 'REALTIME' ? 'REALTIME' : item.quality;
    const sourceMs = item.quoteAt ? Date.parse(item.quoteAt) : NaN, receiptMs = item.receivedAt ? Date.parse(item.receivedAt) : NaN;
    const knownDelaySeconds = Number.isFinite(sourceMs) && Number.isFinite(receiptMs) ? Math.max(0, Number(((receiptMs - sourceMs) / 1000).toFixed(3))) : null;
    const freshness = !item.quoteAt || (item.provider === 'MOOMOO' && !moomoo.connected) ? 'DISCONNECTED'
      : item.provider === 'MOOMOO' ? quoteFreshness(quality as 'REALTIME' | 'DELAYED' | 'UNVERIFIED' | 'STALE' | 'SAMPLE', item.quoteAt, now)
      : item.freshness;
    return { ...item, quality, freshness, knownDelaySeconds, entitlement: item.provider === 'MOOMOO' ? moomoo.entitlement : item.quality };
  });
  const providerName = provider.selected === 'moomoo' ? 'Moomoo OpenAPI' : provider.selected === 'twelvedata' ? 'Twelve Data' : 'Sample';
  return NextResponse.json({ watchlist, rules: listRules(db), events: listEvents(db), jobs: jobRows(db), lastRun, runs, providerHealth,
    lastSuccessfulRefresh: lastSuccess?.at ?? null, workerOnline, market: marketSession(new Date()),
    providerMode: provider.selected === 'sample' ? 'SAMPLE' : 'LIVE', providerName, providerSelection: provider,
    accessClass: provider.selected === 'moomoo' ? moomoo.entitlement : provider.selected === 'twelvedata' ? process.env.STOCK_QUOTE_ACCESS ?? 'UNVERIFIED' : 'SAMPLE',
    moomoo, cadenceMinutes: monitorCadenceMinutes(watchlist.length), configured: provider.selected === 'moomoo' ? moomoo.connected : provider.selected === 'twelvedata' ? Boolean(process.env.TWELVE_DATA_API_KEY) : true });
}
