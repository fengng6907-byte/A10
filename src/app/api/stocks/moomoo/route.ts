import { NextResponse } from 'next/server';
import { connectionStatus } from '@/stocks/moomoo-auth';
import { testMoomooConnection } from '@/stocks/moomoo';
import { stockDb } from '@/stocks/store';

export const dynamic = 'force-dynamic';
export async function GET() { return NextResponse.json(connectionStatus(stockDb())); }
export async function POST() {
  const result = await testMoomooConnection(stockDb());
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
