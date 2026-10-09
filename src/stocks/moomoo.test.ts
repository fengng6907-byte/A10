import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { completeAuthorization, decryptSecret, encryptSecret, pkceChallenge, stateHash } from './moomoo-auth';
import { MoomooEquities, moomooAccessClass, parseMoomooQuotes, quoteFreshness } from './moomoo';
import { ensureStockSchema } from './store';

const testKey = Buffer.alloc(32, 7).toString('base64');

test('Moomoo OAuth secrets use authenticated encryption and PKCE S256', () => {
  const prior = process.env.MOOMOO_TOKEN_ENCRYPTION_KEY;
  process.env.MOOMOO_TOKEN_ENCRYPTION_KEY = testKey;
  try {
    const encrypted = encryptSecret('never-plaintext');
    assert.ok(!encrypted.includes('never-plaintext'));
    assert.equal(decryptSecret(encrypted), 'never-plaintext');
    assert.equal(pkceChallenge('verifier'), 'iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ');
  } finally { if (prior === undefined) delete process.env.MOOMOO_TOKEN_ENCRYPTION_KEY; else process.env.MOOMOO_TOKEN_ENCRYPTION_KEY = prior; }
});

test('Moomoo quote parsing keeps provider timestamps and never promotes unverified access to live', () => {
  const prior = process.env.MOOMOO_US_QUOTE_ACCESS;
  delete process.env.MOOMOO_US_QUOTE_ACCESS;
  try {
    const time = Date.parse('2026-10-09T15:00:00.000Z');
    const [quote] = parseMoomooQuotes({ ret_code: 0, data: { quote_list: [{ code: 'US.MSFT', name: 'Microsoft', data_time: time, last_price: 510.25, open_price: 505, high_price: 512, low_price: 503, prev_close_price: 506, volume: 1234 }] } }, ['MSFT'], new Date('2026-10-09T15:01:00.000Z'));
    assert.equal(quote.quoteAt, '2026-10-09T15:00:00.000Z');
    assert.equal(quote.quality, 'UNVERIFIED');
    assert.equal(quote.freshness, 'DELAYED');
  } finally { if (prior === undefined) delete process.env.MOOMOO_US_QUOTE_ACCESS; else process.env.MOOMOO_US_QUOTE_ACCESS = prior; }
});

test('Moomoo freshness distinguishes real-time, delayed, market-closed, and stale quotes', () => {
  const regularNow = new Date('2026-10-09T15:01:00.000Z');
  assert.equal(quoteFreshness('REALTIME', '2026-10-09T15:00:00.000Z', regularNow), 'LIVE');
  assert.equal(quoteFreshness('DELAYED', '2026-10-09T15:00:00.000Z', regularNow), 'DELAYED');
  assert.equal(quoteFreshness('REALTIME', '2026-10-09T19:59:00.000Z', new Date('2026-10-09T21:00:00.000Z')), 'MARKET_CLOSED');
  assert.equal(quoteFreshness('REALTIME', '2026-10-02T19:59:00.000Z', new Date('2026-10-09T21:00:00.000Z')), 'STALE');
});

test('successful authenticated US quote subscription is used as the real-time access class', () => {
  const prior = process.env.MOOMOO_US_QUOTE_ACCESS;
  delete process.env.MOOMOO_US_QUOTE_ACCESS;
  const db = new Database(':memory:'); ensureStockSchema(db);
  try {
    db.prepare("INSERT INTO moomoo_entitlements(id,market,capability,status,level,checked_at,evidence) VALUES(1,'US','QUOTE_PUSH','CONFIRMED',NULL,?,?)")
      .run(new Date().toISOString(), 'Authenticated subscription accepted.');
    assert.equal(moomooAccessClass(db), 'REALTIME');
  } finally { db.close(); if (prior === undefined) delete process.env.MOOMOO_US_QUOTE_ACCESS; else process.env.MOOMOO_US_QUOTE_ACCESS = prior; }
});

test('OAuth callback rejects trading scopes without storing the token', async () => {
  const prior = process.env.MOOMOO_TOKEN_ENCRYPTION_KEY;
  process.env.MOOMOO_TOKEN_ENCRYPTION_KEY = testKey;
  const db = new Database(':memory:'); ensureStockSchema(db);
  try {
    const state = 'state-value', redirect = 'http://127.0.0.1:3000/api/stocks/moomoo/oauth/callback';
    db.prepare('INSERT INTO moomoo_oauth_clients(id,client_id,redirect_uri,updated_at) VALUES(1,?,?,?)').run('client-id', redirect, new Date().toISOString());
    db.prepare('INSERT INTO moomoo_oauth_sessions(state_hash,verifier_cipher,redirect_uri,expires_at) VALUES(?,?,?,?)').run(stateHash(state), encryptSecret('verifier'), redirect, new Date(Date.now() + 60_000).toISOString());
    const fakeFetch = (async () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 7200, scope: 'quote:read quote:write trade:read accid:123' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await assert.rejects(() => completeAuthorization(db, { state, code: 'code', cookieHash: stateHash(state) }, fakeFetch), /prohibited trading scopes/);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM moomoo_oauth_tokens').get() as { n: number }).n, 0);
  } finally { db.close(); if (prior === undefined) delete process.env.MOOMOO_TOKEN_ENCRYPTION_KEY; else process.env.MOOMOO_TOKEN_ENCRYPTION_KEY = prior; }
});

test('OAuth accepts Moomoo quote and account identifier bundle but uses quote:read only', async () => {
  const prior = process.env.MOOMOO_TOKEN_ENCRYPTION_KEY;
  process.env.MOOMOO_TOKEN_ENCRYPTION_KEY = testKey;
  const db = new Database(':memory:'); ensureStockSchema(db);
  try {
    const state = 'quote-state', redirect = 'http://localhost:3000/api/stocks/moomoo/oauth/callback';
    db.prepare('INSERT INTO moomoo_oauth_clients(id,client_id,redirect_uri,updated_at) VALUES(1,?,?,?)').run('client-id', redirect, new Date().toISOString());
    db.prepare('INSERT INTO moomoo_oauth_sessions(state_hash,verifier_cipher,redirect_uri,expires_at) VALUES(?,?,?,?)').run(stateHash(state), encryptSecret('verifier'), redirect, new Date(Date.now() + 60_000).toISOString());
    const fakeFetch = (async () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 7200, scope: 'quote:read quote:write accid:123 accid:456' }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const result = await completeAuthorization(db, { state, code: 'code', cookieHash: stateHash(state) }, fakeFetch);
    assert.equal(result.scope, 'quote:read quote:write accid:123 accid:456');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM moomoo_oauth_tokens').get() as { n: number }).n, 1);
  } finally { db.close(); if (prior === undefined) delete process.env.MOOMOO_TOKEN_ENCRYPTION_KEY; else process.env.MOOMOO_TOKEN_ENCRYPTION_KEY = prior; }
});

test('authenticated Moomoo provider batches arbitrary US watchlist symbols', async () => {
  const priorKey = process.env.MOOMOO_TOKEN_ENCRYPTION_KEY, priorAccess = process.env.MOOMOO_US_QUOTE_ACCESS;
  process.env.MOOMOO_TOKEN_ENCRYPTION_KEY = testKey; process.env.MOOMOO_US_QUOTE_ACCESS = 'REALTIME';
  const db = new Database(':memory:'); ensureStockSchema(db);
  try {
    db.prepare('INSERT INTO moomoo_oauth_tokens(id,access_cipher,refresh_cipher,token_type,scope,expires_at,updated_at) VALUES(1,?,?,?,?,?,?)')
      .run(encryptSecret('access-token'), encryptSecret('refresh-token'), 'Bearer', 'quote:read', new Date(Date.now() + 3_600_000).toISOString(), new Date().toISOString());
    let authorization = '', requested: string[] = [];
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      requested = JSON.parse(String(init?.body)).code_list;
      return new Response(JSON.stringify({ ret_code: 0, data: { quote_list: requested.map((code, index) => ({ code, name: code.slice(3), data_time: Date.now(), last_price: 100 + index, prev_close_price: 99 + index, volume: 1000 })) } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const provider = new MoomooEquities(db, fakeFetch);
    const quotes = await provider.getQuotes(['TSLA', 'MSFT']);
    assert.equal(authorization, 'Bearer access-token');
    assert.deepEqual(requested, ['US.TSLA', 'US.MSFT']);
    assert.deepEqual(quotes.map(x => x.ticker), ['TSLA', 'MSFT']);
    const { diagnostic } = await provider.diagnoseQuotes(['TSLA', 'MSFT']);
    assert.equal(diagnostic.endpoint, 'https://webapi.moomoo.com/api/v1.0/quote/stock-quote');
    assert.equal(diagnostic.authentication, 'Bearer [REDACTED]');
    assert.equal(diagnostic.cache, 'BYPASSED_FOR_DIAGNOSTIC');
    assert.equal(diagnostic.response.quote_list[0].data_time_unit, 'UNIX_MILLISECONDS');
    assert.equal(JSON.stringify(diagnostic).includes('access-token'), false);
  } finally { db.close(); if (priorKey === undefined) delete process.env.MOOMOO_TOKEN_ENCRYPTION_KEY; else process.env.MOOMOO_TOKEN_ENCRYPTION_KEY = priorKey; if (priorAccess === undefined) delete process.env.MOOMOO_US_QUOTE_ACCESS; else process.env.MOOMOO_US_QUOTE_ACCESS = priorAccess; }
});
