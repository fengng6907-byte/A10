import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

async function main() {
  const { stockDb } = await import('./stocks/store');
  const { ensureMonitorJob, runOneJob } = await import('./stocks/jobs');
  const db = stockDb();
  const { providerConfiguration } = await import('./stocks/provider');
  const stream = providerConfiguration().selected === 'moomoo' && process.env.MOOMOO_STREAMING_ENABLED === 'true'
    ? (await import('./stocks/moomoo-stream')).startMoomooQuoteStream(db) : null;
  const workerProvider = providerConfiguration().selected;
  const owner = `worker-${process.pid}`;
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  console.log(`${owner} started; market data mode ${process.env.STOCK_DATA_MODE ?? 'sample'}`);
  while (!stopping) {
    try {
      const now = new Date();
      db.prepare("INSERT INTO stock_meta(key,value) VALUES('worker_last_seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(now.toISOString());
      db.prepare("INSERT INTO stock_meta(key,value) VALUES('worker_provider',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(workerProvider);
      ensureMonitorJob(db, now);
      const outcome = await runOneJob(db);
      if (outcome) console.log(`${new Date().toISOString()} ${outcome.job.kind}: ${outcome.status}${'error' in outcome ? ` — ${outcome.error}` : ` — ${outcome.result.items} quotes`}`);
    } catch (error) { console.error(`${new Date().toISOString()} worker loop:`, error); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 10_000));
  }
  db.prepare("INSERT INTO stock_meta(key,value) VALUES('worker_last_seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
  stream?.close();
  console.log(`${owner} stopped`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
