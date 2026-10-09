import { NextResponse } from 'next/server';
import { z } from 'zod';
import { addTrade, getSettings, getTrades } from '@/lib/db';
import { positionSize, riskLimits } from '@/lib/risk';
const schema = z.object({ side: z.enum(['BUY', 'SELL']), entry: z.number().positive(), stop: z.number().positive(), target: z.number().positive(), notes: z.string().max(2000).default('') });
export async function GET() { return NextResponse.json(getTrades()); }
export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Invalid trade details' }, { status: 400 });
  const settings = getSettings(), trades = getTrades(), limits = riskLimits(settings, trades);
  const pos = positionSize(settings, parsed.data.entry, parsed.data.stop, parsed.data.target);
  const reasons = [...limits.reasons, ...pos.blockingReasons];
  if (parsed.data.side === 'BUY' && !(parsed.data.stop < parsed.data.entry && parsed.data.target > parsed.data.entry)) reasons.push('BUY requires stop below entry and target above entry');
  if (parsed.data.side === 'SELL' && !(parsed.data.stop > parsed.data.entry && parsed.data.target < parsed.data.entry)) reasons.push('SELL requires stop above entry and target below entry');
  if (pos.riskUSD > limits.dailyRiskRemaining) reasons.push('Planned risk exceeds daily risk remaining');
  if (reasons.length) return NextResponse.json({ error: reasons.join('; ') }, { status: 400 });
  addTrade({ openedAt: new Date().toISOString(), ...parsed.data, lots: pos.lots, plannedRisk: pos.actualRiskUSD, realizedPnl: null, status: 'PLANNED' });
  return NextResponse.json({ ok: true }, { status: 201 });
}
