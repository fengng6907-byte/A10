import type Database from 'better-sqlite3';
import { get, put } from '@vercel/blob';

const SNAPSHOT_PATH = 'a10-private/moomoo-oauth.json';
const hydrated = new WeakSet<Database.Database>();

type Snapshot = {
  version: 1;
  updatedAt: string;
  client: Record<string, unknown> | null;
  sessions: Record<string, unknown>[];
  token: Record<string, unknown> | null;
  entitlement: Record<string, unknown> | null;
};

function enabled() { return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim()); }

export async function hydrateMoomooState(db: Database.Database) {
  if (!enabled() || hydrated.has(db)) return;
  const result = await get(SNAPSHOT_PATH, { access: 'private' });
  if (!result || result.statusCode !== 200 || !result.stream) { hydrated.add(db); return; }
  const snapshot = JSON.parse(await new Response(result.stream).text()) as Snapshot;
  if (snapshot.version !== 1) throw new Error('Unsupported Moomoo OAuth snapshot version');
  db.transaction(() => {
    if (snapshot.client) db.prepare(`INSERT OR REPLACE INTO moomoo_oauth_clients(id,client_id,redirect_uri,registration_token_cipher,updated_at)
      VALUES(1,@client_id,@redirect_uri,@registration_token_cipher,@updated_at)`).run(snapshot.client);
    for (const row of snapshot.sessions ?? []) db.prepare(`INSERT OR REPLACE INTO moomoo_oauth_sessions(state_hash,verifier_cipher,redirect_uri,expires_at,used_at)
      VALUES(@state_hash,@verifier_cipher,@redirect_uri,@expires_at,@used_at)`).run(row);
    if (snapshot.token) db.prepare(`INSERT OR REPLACE INTO moomoo_oauth_tokens(id,access_cipher,refresh_cipher,token_type,scope,expires_at,updated_at)
      VALUES(1,@access_cipher,@refresh_cipher,@token_type,@scope,@expires_at,@updated_at)`).run(snapshot.token);
    if (snapshot.entitlement) db.prepare(`INSERT OR REPLACE INTO moomoo_entitlements(id,market,capability,status,level,checked_at,evidence)
      VALUES(1,@market,@capability,@status,@level,@checked_at,@evidence)`).run(snapshot.entitlement);
  })();
  hydrated.add(db);
}

export async function persistMoomooState(db: Database.Database) {
  if (!enabled()) return;
  const snapshot: Snapshot = {
    version: 1,
    updatedAt: new Date().toISOString(),
    client: db.prepare('SELECT client_id,redirect_uri,registration_token_cipher,updated_at FROM moomoo_oauth_clients WHERE id=1').get() as Record<string, unknown> | undefined ?? null,
    sessions: db.prepare('SELECT state_hash,verifier_cipher,redirect_uri,expires_at,used_at FROM moomoo_oauth_sessions WHERE expires_at>=? ORDER BY expires_at DESC LIMIT 10').all(new Date().toISOString()) as Record<string, unknown>[],
    token: db.prepare('SELECT access_cipher,refresh_cipher,token_type,scope,expires_at,updated_at FROM moomoo_oauth_tokens WHERE id=1').get() as Record<string, unknown> | undefined ?? null,
    entitlement: db.prepare('SELECT market,capability,status,level,checked_at,evidence FROM moomoo_entitlements WHERE id=1').get() as Record<string, unknown> | undefined ?? null,
  };
  await put(SNAPSHOT_PATH, JSON.stringify(snapshot), { access: 'private', addRandomSuffix: false, allowOverwrite: true, cacheControlMaxAge: 60, contentType: 'application/json' });
  hydrated.add(db);
}
