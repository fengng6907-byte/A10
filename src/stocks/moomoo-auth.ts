import type Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hydrateMoomooState, persistMoomooState } from './moomoo-persistence';

const API_HOST = 'https://webapi.moomoo.com';
const ALLOWED_SCOPE = 'quote:read';

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown; error_description?: unknown };

function localKeyPath() {
  const dbPath = process.env.DATABASE_PATH ? resolve(process.env.DATABASE_PATH) : join(process.cwd(), 'data', 'gold-ai-copilot.db');
  return join(dirname(dbPath), '.moomoo-token-key');
}

export function tokenEncryptionKey(): Buffer {
  const configured = process.env.MOOMOO_TOKEN_ENCRYPTION_KEY?.trim();
  if (configured) {
    const value = /^[0-9a-f]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64');
    if (value.length !== 32) throw new Error('MOOMOO_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hexadecimal characters');
    return value;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('MOOMOO_TOKEN_ENCRYPTION_KEY is required in production');
  const path = localKeyPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('base64'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs apply instead of POSIX mode bits. */ }
  }
  const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('Local Moomoo token encryption key is invalid');
  return key;
}

export function encryptSecret(value: string, key = tokenEncryptionKey()) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(value: string, key = tokenEncryptionKey()) {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Encrypted Moomoo credential has an invalid format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');
export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function oauthRedirectUri(origin: string) {
  return process.env.MOOMOO_REDIRECT_URI?.trim() || `${origin}/api/stocks/moomoo/oauth/callback`;
}

export async function ensureOAuthClient(db: Database.Database, redirectUri: string, fetchImpl: typeof fetch = fetch) {
  const configured = process.env.MOOMOO_CLIENT_ID?.trim();
  if (configured) return { clientId: configured, redirectUri };
  const existing = db.prepare('SELECT client_id AS clientId,redirect_uri AS redirectUri FROM moomoo_oauth_clients WHERE id=1').get() as { clientId: string; redirectUri: string } | undefined;
  if (existing) {
    if (existing.redirectUri !== redirectUri) throw new Error(`Registered Moomoo redirect URI is ${existing.redirectUri}; set MOOMOO_REDIRECT_URI to that exact value or reconnect with a new database`);
    return existing;
  }
  const response = await fetchImpl(`${API_HOST}/oauth2/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: 'A10 (read-only quotes)' })
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof data.client_id !== 'string') throw new Error(`Moomoo OAuth client registration failed (${response.status}): ${String(data.error_description ?? data.error ?? 'invalid response')}`);
  const registration = typeof data.registration_access_token === 'string' ? encryptSecret(data.registration_access_token) : null;
  db.prepare(`INSERT INTO moomoo_oauth_clients(id,client_id,redirect_uri,registration_token_cipher,updated_at) VALUES(1,?,?,?,?)`).run(data.client_id, redirectUri, registration, new Date().toISOString());
  await persistMoomooState(db);
  return { clientId: data.client_id, redirectUri };
}

export async function createAuthorization(db: Database.Database, origin: string, fetchImpl: typeof fetch = fetch) {
  await hydrateMoomooState(db);
  const redirectUri = oauthRedirectUri(origin);
  const client = await ensureOAuthClient(db, redirectUri, fetchImpl);
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(64).toString('base64url');
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  db.prepare('DELETE FROM moomoo_oauth_sessions WHERE expires_at<? OR used_at IS NOT NULL').run(new Date().toISOString());
  db.prepare('INSERT INTO moomoo_oauth_sessions(state_hash,verifier_cipher,redirect_uri,expires_at) VALUES(?,?,?,?)').run(stateHash(state), encryptSecret(verifier), redirectUri, expiresAt);
  await persistMoomooState(db);
  const url = new URL(`${API_HOST}/oauth2/authorize/confirm`);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return { url: url.toString(), state, clientId: client.clientId };
}

function validateReadOnlyScope(scope: string) {
  const scopes = new Set(scope.split(/\s+/).filter(Boolean));
  if (!scopes.has(ALLOWED_SCOPE)) throw new Error('Moomoo authorization did not grant quote:read');
  const prohibited = [...scopes].filter(x => x.startsWith('trade:'));
  if (prohibited.length) throw new Error(`Moomoo returned prohibited trading scopes (${prohibited.join(', ')}). No token was stored.`);
}

function saveTokenResponse(db: Database.Database, data: TokenResponse, priorRefresh?: string) {
  if (typeof data.access_token !== 'string' || typeof data.scope !== 'string') throw new Error('Moomoo token response is incomplete');
  const refresh = typeof data.refresh_token === 'string' ? data.refresh_token : priorRefresh;
  if (!refresh) throw new Error('Moomoo token response did not include a refresh token');
  validateReadOnlyScope(data.scope);
  const seconds = Number(data.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Moomoo token expiry is invalid');
  const now = new Date(), expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
  const storedScope = data.scope.split(/\s+/).filter(Boolean).map(scope => scope.startsWith('accid:') ? 'accid:*' : scope).join(' ');
  db.prepare(`INSERT INTO moomoo_oauth_tokens(id,access_cipher,refresh_cipher,token_type,scope,expires_at,updated_at) VALUES(1,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET access_cipher=excluded.access_cipher,refresh_cipher=excluded.refresh_cipher,token_type=excluded.token_type,scope=excluded.scope,expires_at=excluded.expires_at,updated_at=excluded.updated_at`)
    .run(encryptSecret(data.access_token), encryptSecret(refresh), typeof data.token_type === 'string' ? data.token_type : 'Bearer', storedScope, expiresAt, now.toISOString());
  return { scope: data.scope, expiresAt };
}

async function tokenRequest(body: URLSearchParams, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${API_HOST}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, cache: 'no-store' });
  const data = await response.json() as TokenResponse;
  if (!response.ok || data.error) throw new Error(`Moomoo OAuth token request failed (${response.status}): ${String(data.error_description ?? data.error ?? 'invalid response')}`);
  return data;
}

export async function completeAuthorization(db: Database.Database, input: { state: string; code: string; cookieHash: string | undefined }, fetchImpl: typeof fetch = fetch) {
  const hash = stateHash(input.state);
  if (!input.cookieHash || input.cookieHash !== hash) throw new Error('Moomoo OAuth state cookie mismatch');
  await hydrateMoomooState(db);
  const session = db.prepare('SELECT verifier_cipher AS verifierCipher,redirect_uri AS redirectUri,expires_at AS expiresAt,used_at AS usedAt FROM moomoo_oauth_sessions WHERE state_hash=?').get(hash) as { verifierCipher: string; redirectUri: string; expiresAt: string; usedAt: string | null } | undefined;
  if (!session || session.usedAt || Date.parse(session.expiresAt) < Date.now()) throw new Error('Moomoo OAuth state is missing, expired, or already used');
  const client = await ensureOAuthClient(db, session.redirectUri, fetchImpl);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, client_id: client.clientId, redirect_uri: session.redirectUri, code_verifier: decryptSecret(session.verifierCipher) });
  const result = saveTokenResponse(db, await tokenRequest(body, fetchImpl));
  db.prepare('UPDATE moomoo_oauth_sessions SET used_at=? WHERE state_hash=?').run(new Date().toISOString(), hash);
  await persistMoomooState(db);
  return result;
}

export async function getAccessToken(db: Database.Database, fetchImpl: typeof fetch = fetch) {
  await hydrateMoomooState(db);
  const row = db.prepare('SELECT access_cipher AS accessCipher,refresh_cipher AS refreshCipher,scope,expires_at AS expiresAt FROM moomoo_oauth_tokens WHERE id=1').get() as { accessCipher: string; refreshCipher: string; scope: string; expiresAt: string } | undefined;
  if (!row) throw new Error('Moomoo is not connected. Complete the read-only OAuth authorization first.');
  validateReadOnlyScope(row.scope);
  if (Date.parse(row.expiresAt) > Date.now() + 60_000) return decryptSecret(row.accessCipher);
  const clientId = process.env.MOOMOO_CLIENT_ID?.trim() || (db.prepare('SELECT client_id AS clientId FROM moomoo_oauth_clients WHERE id=1').get() as { clientId: string } | undefined)?.clientId;
  if (!clientId) throw new Error('Moomoo OAuth client ID is unavailable');
  const refresh = decryptSecret(row.refreshCipher);
  const data = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }), fetchImpl);
  saveTokenResponse(db, data, refresh);
  await persistMoomooState(db);
  return decryptSecret((db.prepare('SELECT access_cipher AS accessCipher FROM moomoo_oauth_tokens WHERE id=1').get() as { accessCipher: string }).accessCipher);
}

export function connectionStatus(db: Database.Database) {
  const client = Boolean(process.env.MOOMOO_CLIENT_ID?.trim()) || Boolean(db.prepare('SELECT 1 FROM moomoo_oauth_clients WHERE id=1').get());
  const token = db.prepare('SELECT scope,expires_at AS expiresAt,updated_at AS updatedAt FROM moomoo_oauth_tokens WHERE id=1').get() as { scope: string; expiresAt: string; updatedAt: string } | undefined;
  const health = db.prepare('SELECT checked_at AS checkedAt,status,latency_ms AS latencyMs,http_status AS httpStatus,provider_timestamp AS providerTimestamp,detail FROM moomoo_provider_health ORDER BY id DESC LIMIT 1').get() ?? null;
  const probed = db.prepare("SELECT status,level,checked_at AS checkedAt,evidence FROM moomoo_entitlements WHERE id=1 AND market='US' AND capability='QUOTE_PUSH'").get() as { status: string; level: string | null; checkedAt: string; evidence: string } | undefined;
  const declared = process.env.MOOMOO_US_QUOTE_ACCESS;
  const entitlement = declared === 'REALTIME' || (!declared && probed?.status === 'CONFIRMED') ? 'REALTIME' : declared === 'DELAYED' ? 'DELAYED' : 'UNVERIFIED';
  const granted = token?.scope.split(/\s+/).filter(Boolean) ?? [];
  const ignoredScopes = granted.filter(x => x !== ALLOWED_SCOPE).map(x => x.startsWith('accid:') ? 'accid:*' : x);
  return { clientRegistered: client, connected: Boolean(token), scope: token ? ALLOWED_SCOPE : null, ignoredScopes: [...new Set(ignoredScopes)], tokenExpiresAt: token?.expiresAt ?? null,
    entitlement, entitlementStatus: declared ? 'DECLARED' : probed?.status ?? 'UNVERIFIED', entitlementLevel: probed?.level ?? null,
    entitlementCheckedAt: probed?.checkedAt ?? null, entitlementEvidence: declared ? `Configured by MOOMOO_US_QUOTE_ACCESS=${declared}.` : probed?.evidence ?? null,
    quoteCacheSeconds: Math.max(1, Number(process.env.MOOMOO_QUOTE_CACHE_SECONDS ?? 5)), websocketEnabled: process.env.MOOMOO_STREAMING_ENABLED === 'true', health };
}
