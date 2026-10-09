import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

async function main() {
  const { stockDb } = await import('./store');
  const { connectionStatus } = await import('./moomoo-auth');
  const { testMoomooConnection } = await import('./moomoo');
  const db = stockDb();
  const result = await testMoomooConnection(db);
  const status = connectionStatus(db);
  console.log(JSON.stringify({ configuration: { connected: status.connected, scope: status.scope, entitlement: status.entitlement,
    entitlementStatus: status.entitlementStatus, entitlementCheckedAt: status.entitlementCheckedAt, websocketEnabled: status.websocketEnabled }, result }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
