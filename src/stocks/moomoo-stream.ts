import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getAccessToken } from './moomoo-auth';
import { moomooAccessClass, parseMoomooQuotes } from './moomoo';
import { processAlertRules } from './alerts';
import { findCompany, listWatchlist, saveQuote } from './store';

type PushMessage = { id?: unknown; code?: unknown; message?: unknown; session_id?: unknown; type?: unknown; symbol?: unknown; data?: Record<string, unknown> };

export function startMoomooQuoteStream(db: Database.Database) {
  let stopped = false, socket: WebSocket | null = null, reconnects = 0, reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  const setHealth = (status: string, detail: string, providerTimestamp?: string) => db.prepare('INSERT INTO moomoo_provider_health(checked_at,status,provider_timestamp,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), status, providerTimestamp ?? null, detail.slice(0, 500));
  const symbols = () => (listWatchlist(db) as { ticker: string }[]).map(x => `US.${x.ticker}`);

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(reconnects++, 5)));
  };

  async function sendAuth(action: 'auth' | 'refresh') {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const token = await getAccessToken(db);
    socket.send(JSON.stringify({ id: `${action}-${randomUUID()}`, action, data: { ...(action === 'auth' ? { auth_type: 'oauth2' } : {}), authorization: `Bearer ${token}` } }));
  }

  async function connect() {
    if (stopped) return;
    try {
      socket = new WebSocket('wss://webapi-quote.moomoo.com/ws');
      socket.addEventListener('open', () => { void sendAuth('auth').catch(error => { setHealth('DISCONNECTED', error instanceof Error ? error.message : 'WebSocket authentication failed'); socket?.close(); }); });
      socket.addEventListener('message', event => {
        void (async () => {
          let message: PushMessage;
          try { message = JSON.parse(String(event.data)) as PushMessage; } catch { return; }
          if (Number(message.code ?? 0) !== 0) {
            setHealth('DISCONNECTED', `Moomoo WebSocket ${String(message.code)}: ${String(message.message ?? 'request failed')}`);
            return;
          }
          if (message.session_id) {
            reconnects = 0;
            socket?.send(JSON.stringify({ id: `subscribe-${randomUUID()}`, action: 'subscribe', quote: symbols() }));
            if (!refreshTimer) refreshTimer = setInterval(() => void sendAuth('refresh').catch(error => setHealth('DISCONNECTED', error instanceof Error ? error.message : 'WebSocket refresh failed')), 5 * 60_000);
            setHealth('CONNECTED', 'Authenticated Moomoo WebSocket quote channel.');
            return;
          }
          if (message.type !== 'QUOTE' || typeof message.symbol !== 'string' || !message.data) return;
          const ticker = message.symbol.startsWith('US.') ? message.symbol.slice(3).toUpperCase() : '';
          const company = ticker ? findCompany(db, ticker) : undefined;
          if (!company) return;
          const quote = parseMoomooQuotes({ ret_code: 0, data: { quote_list: [{ code: message.symbol, name: company.name, data_time: message.data.data_time_ms, ...message.data }] } }, [ticker], new Date(), moomooAccessClass(db))[0];
          saveQuote(db, company.id, quote);
          processAlertRules(db, company.id, quote);
          setHealth('CONNECTED', `Moomoo WebSocket quote received for ${ticker}.`, quote.quoteAt);
        })().catch(error => setHealth('DISCONNECTED', error instanceof Error ? error.message : 'WebSocket quote processing failed'));
      });
      socket.addEventListener('close', () => { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } socket = null; scheduleReconnect(); });
      socket.addEventListener('error', () => setHealth('DISCONNECTED', 'Moomoo WebSocket connection error; REST polling remains available.'));
    } catch (error) {
      setHealth('DISCONNECTED', error instanceof Error ? error.message : 'Unable to create Moomoo WebSocket');
      scheduleReconnect();
    }
  }

  void connect();
  return { close() { stopped = true; if (reconnectTimer) clearTimeout(reconnectTimer); if (refreshTimer) clearInterval(refreshTimer); socket?.close(); } };
}
