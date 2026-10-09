import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findCompany, stockDb } from '@/stocks/store';
const tickerSchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.-]{0,9}$/);
const bodySchema = z.object({ ticker: tickerSchema, referencePrice: z.number().positive().nullable().optional(), notes: z.string().max(1000).optional() });
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Valid US ticker required' }, { status: 400 });
  const db = stockDb(), now = new Date().toISOString(), { ticker, referencePrice, notes } = parsed.data;
  db.transaction(() => {
    db.prepare('INSERT INTO stock_companies(ticker,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(ticker) DO NOTHING').run(ticker, ticker, now, now);
    const company = findCompany(db, ticker)!;
    db.prepare('INSERT INTO stock_watchlist(company_id,reference_price,date_added,notes) VALUES(?,?,?,?) ON CONFLICT(company_id) DO UPDATE SET reference_price=excluded.reference_price,notes=excluded.notes')
      .run(company.id, referencePrice ?? null, now, notes ?? '');
    db.prepare('INSERT INTO stock_ticker_history(company_id,ticker,valid_from) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM stock_ticker_history WHERE company_id=?)')
      .run(company.id, ticker, now, company.id);
  })();
  return NextResponse.json({ ok: true }, { status: 201 });
}
export async function DELETE(request: Request) {
  const ticker = tickerSchema.safeParse(new URL(request.url).searchParams.get('ticker'));
  if (!ticker.success) return NextResponse.json({ error: 'Invalid ticker' }, { status: 400 });
  const db = stockDb(), company = findCompany(db, ticker.data);
  if (!company) return NextResponse.json({ error: 'Ticker not found' }, { status: 404 });
  db.prepare('DELETE FROM stock_watchlist WHERE company_id=?').run(company.id);
  db.prepare('UPDATE stock_alert_rules SET active=0,updated_at=? WHERE company_id=?').run(new Date().toISOString(), company.id);
  return NextResponse.json({ ok: true });
}
