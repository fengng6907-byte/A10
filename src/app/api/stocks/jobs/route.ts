import { NextResponse } from 'next/server';
import { enqueueMonitor, runOneJob } from '@/stocks/jobs';
import { stockDb } from '@/stocks/store';
export async function POST() {
  const db = stockDb();
  enqueueMonitor(db);
  const result = await runOneJob(db);
  return NextResponse.json(result?.status === 'ERROR' ? { ok: false, error: result.error } : { ok: true, items: result?.result?.items ?? 0 }, { status: result?.status === 'ERROR' ? 503 : 200 });
}
