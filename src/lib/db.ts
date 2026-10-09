import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Settings, Trade } from './types';

const defaults: Settings = { balance: 200, riskPercent: 0.5, contractSize: 100, minLot: 0.01, lotStep: 0.01, maxLeverage: 20, maxTradesPerDay: 2, maxDailyLossPercent: 1, maxWeeklyDrawdownPercent: 4, minRewardRisk: 2 };
let instance: Database.Database | undefined;
function db() {
  if (instance) return instance;
  const file = process.env.DATABASE_PATH ? resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH)
    : process.env.VERCEL ? join('/tmp', 'a10.db') : join(process.cwd(), 'data', 'gold-ai-copilot.db');
  mkdirSync(dirname(file), { recursive: true });
  instance = new Database(file);
  instance.pragma('journal_mode = WAL');
  instance.exec(`CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, opened_at TEXT NOT NULL, side TEXT NOT NULL,
      entry REAL NOT NULL, stop REAL NOT NULL, target REAL NOT NULL, lots REAL NOT NULL, planned_risk REAL NOT NULL,
      realized_pnl REAL, status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '');`);
  return instance;
}
export function getDatabase() { return db(); }
export function getSettings(): Settings {
  const row = db().prepare('SELECT json FROM settings WHERE id=1').get() as { json: string } | undefined;
  return row ? { ...defaults, ...JSON.parse(row.json) } : defaults;
}
export function saveSettings(settings: Settings) {
  db().prepare('INSERT INTO settings(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(settings));
}
export function getTrades(): Trade[] {
  const rows = db().prepare('SELECT * FROM trades ORDER BY opened_at DESC, id DESC').all() as Record<string, unknown>[];
  return rows.map(r => ({ id: Number(r.id), openedAt: String(r.opened_at), side: r.side as Trade['side'], entry: Number(r.entry), stop: Number(r.stop), target: Number(r.target), lots: Number(r.lots), plannedRisk: Number(r.planned_risk), realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl), status: r.status as Trade['status'], notes: String(r.notes) }));
}
export function addTrade(trade: Omit<Trade, 'id'>) {
  db().prepare('INSERT INTO trades(opened_at,side,entry,stop,target,lots,planned_risk,realized_pnl,status,notes) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(trade.openedAt, trade.side, trade.entry, trade.stop, trade.target, trade.lots, trade.plannedRisk, trade.realizedPnl, trade.status, trade.notes);
}
export function closeTrade(id: number, realizedPnl: number, notes: string) {
  return db().prepare("UPDATE trades SET status='CLOSED', realized_pnl=?, notes=? WHERE id=? AND status='PLANNED'").run(realizedPnl, notes, id).changes;
}
