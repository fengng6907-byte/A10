import { NextResponse } from 'next/server';
import { z } from 'zod';
import { findCompany, stockDb } from '@/stocks/store';
const schema = z.object({ ticker: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9.-]{0,9}$/),
  kind: z.enum(['PRICE_BELOW','PRICE_ABOVE','PERCENT_DROP','PERCENT_INCREASE','WEEK_52_HIGH','WEEK_52_LOW','UNUSUAL_VOLUME','GAP_OPEN','VALUATION_RANGE']),
  threshold: z.number().positive().nullable().optional(), referencePrice: z.number().positive().nullable().optional(),
  lowerBound: z.number().positive().nullable().optional(), upperBound: z.number().positive().nullable().optional(),
  volumeMultiple: z.number().min(1).nullable().optional(), cooldownMinutes: z.number().int().min(0).max(10080).default(60),
  rearmPercent: z.number().min(0).max(25).default(1) });
export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid alert rule' }, { status: 400 });
  const data = parsed.data;
  if (data.kind === 'VALUATION_RANGE' ? !(data.lowerBound && data.upperBound && data.lowerBound < data.upperBound) : !['WEEK_52_HIGH','WEEK_52_LOW'].includes(data.kind) && !data.threshold)
    return NextResponse.json({ error: 'This rule needs a valid threshold or price range' }, { status: 400 });
  const db = stockDb(), company = findCompany(db, data.ticker);
  if (!company || !db.prepare('SELECT 1 FROM stock_watchlist WHERE company_id=?').get(company.id)) return NextResponse.json({ error: 'Add ticker to watchlist first' }, { status: 400 });
  const now = new Date().toISOString();
  const row = db.prepare(`INSERT INTO stock_alert_rules(company_id,kind,threshold,reference_price,lower_bound,upper_bound,volume_multiple,cooldown_minutes,rearm_percent,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(company.id,data.kind,data.threshold ?? null,data.referencePrice ?? null,data.lowerBound ?? null,data.upperBound ?? null,data.volumeMultiple ?? null,data.cooldownMinutes,data.rearmPercent,now,now);
  return NextResponse.json({ ok: true, id: Number(row.lastInsertRowid) }, { status: 201 });
}
export async function PATCH(request: Request) {
  const parsed = z.object({ id: z.number().int().positive(), active: z.boolean().optional(), threshold: z.number().positive().nullable().optional(),
    referencePrice: z.number().positive().nullable().optional(), lowerBound: z.number().positive().nullable().optional(),
    upperBound: z.number().positive().nullable().optional(), volumeMultiple: z.number().min(1).nullable().optional(),
    cooldownMinutes: z.number().int().min(0).max(10080).optional(), rearmPercent: z.number().min(0).max(25).optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid update' }, { status: 400 });
  const db = stockDb(), now = new Date().toISOString();
  const columns: Record<string,string> = { active: 'active', threshold: 'threshold', referencePrice: 'reference_price', lowerBound: 'lower_bound', upperBound: 'upper_bound', volumeMultiple: 'volume_multiple', cooldownMinutes: 'cooldown_minutes', rearmPercent: 'rearm_percent' };
  const edits = Object.entries(parsed.data).filter(([key]) => key !== 'id');
  if (!edits.length) return NextResponse.json({ error: 'No changes' }, { status: 400 });
  const assignments = edits.map(([key]) => `${columns[key]}=?`).join(',');
  const values = edits.map(([key,value]) => key === 'active' ? Number(value) : value);
  const resetArm = edits.some(([key]) => key !== 'active') ? ',armed=1' : '';
  const changed = db.prepare(`UPDATE stock_alert_rules SET ${assignments}${resetArm},updated_at=? WHERE id=?`).run(...values,now,parsed.data.id).changes;
  return changed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Rule not found' }, { status: 404 });
}
export async function DELETE(request: Request) {
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ error: 'Invalid rule' }, { status: 400 });
  const changed = stockDb().prepare('UPDATE stock_alert_rules SET active=0,updated_at=? WHERE id=?').run(new Date().toISOString(), id).changes;
  return changed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Rule not found' }, { status: 404 });
}
