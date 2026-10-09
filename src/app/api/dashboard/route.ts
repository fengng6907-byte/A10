import { NextResponse } from 'next/server';
import { getSettings, getTrades } from '@/lib/db';
import { calculateDashboard } from '@/lib/strategy';
import { getExplanation } from '@/lib/ai';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const dashboard = await calculateDashboard(getSettings(), getTrades());
    const ai = await getExplanation(dashboard.analysis, { fourHour: dashboard.fourHour, oneHour: dashboard.oneHour, fifteenMinute: dashboard.fifteenMinute, limits: dashboard.limits, position: dashboard.position });
    return NextResponse.json({ ...dashboard, ai });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Analysis unavailable' }, { status: 503 });
  }
}
