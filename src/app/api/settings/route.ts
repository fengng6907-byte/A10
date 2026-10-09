import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSettings, saveSettings } from '@/lib/db';
const schema = z.object({ balance: z.number().positive(), riskPercent: z.number().positive().max(5), contractSize: z.number().positive(), minLot: z.number().positive(), lotStep: z.number().positive(), maxLeverage: z.number().positive().max(100), maxTradesPerDay: z.number().int().positive().max(20), maxDailyLossPercent: z.number().positive().max(20), maxWeeklyDrawdownPercent: z.number().positive().max(50), minRewardRisk: z.number().positive().max(20) }).strict();
export async function GET() { return NextResponse.json(getSettings()); }
export async function PUT(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map(i => i.message).join('; ') }, { status: 400 });
  if (parsed.data.minLot < parsed.data.lotStep) return NextResponse.json({ error: 'Minimum lot must be at least one lot step' }, { status: 400 });
  saveSettings(parsed.data);
  return NextResponse.json(parsed.data);
}
