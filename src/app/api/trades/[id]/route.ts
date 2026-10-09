import { NextResponse } from 'next/server';
import { z } from 'zod';
import { closeTrade } from '@/lib/db';
const schema = z.object({ realizedPnl: z.number().finite(), notes: z.string().max(2000) });
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success || !Number.isInteger(Number(id))) return NextResponse.json({ error: 'Invalid close details' }, { status: 400 });
  const changed = closeTrade(Number(id), parsed.data.realizedPnl, parsed.data.notes);
  return changed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Planned trade not found' }, { status: 404 });
}
