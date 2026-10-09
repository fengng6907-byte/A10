import { NextRequest, NextResponse } from 'next/server';
import { completeAuthorization } from '@/stocks/moomoo-auth';
import { stockDb } from '@/stocks/store';

export const dynamic = 'force-dynamic';
const safeMessage = (value: string) => value.replace(/accid:\d+/g, 'accid:*');
export async function GET(request: NextRequest) {
  const db = stockDb();
  const code = request.nextUrl.searchParams.get('code'), state = request.nextUrl.searchParams.get('state');
  try {
    if (!code || !state) throw new Error(request.nextUrl.searchParams.get('error_description') || request.nextUrl.searchParams.get('error') || 'Moomoo authorization callback is missing code or state');
    await completeAuthorization(db, { code, state, cookieHash: request.cookies.get('moomoo_oauth_state')?.value });
    db.prepare("INSERT INTO moomoo_provider_health(checked_at,status,detail) VALUES(?,'CONNECTED',?)").run(new Date().toISOString(), 'Read-only Moomoo OAuth authorization completed. Run the TSLA/MSFT connection test to verify US quote entitlement.');
    const response = NextResponse.redirect(new URL('/stocks?moomoo=connected', request.url));
    response.cookies.set('moomoo_oauth_state', '', { httpOnly: true, sameSite: 'lax', secure: request.nextUrl.protocol === 'https:', path: '/api/stocks/moomoo/oauth/callback', maxAge: 0 });
    return response;
  } catch (error) {
    const message = safeMessage(error instanceof Error ? error.message : 'Moomoo authorization failed');
    db.prepare("INSERT INTO moomoo_provider_health(checked_at,status,detail) VALUES(?,'DISCONNECTED',?)").run(new Date().toISOString(), message.slice(0, 500));
    const response = NextResponse.redirect(new URL(`/stocks?moomoo=error&detail=${encodeURIComponent(message.slice(0, 180))}`, request.url));
    response.cookies.set('moomoo_oauth_state', '', { httpOnly: true, sameSite: 'lax', secure: request.nextUrl.protocol === 'https:', path: '/api/stocks/moomoo/oauth/callback', maxAge: 0 });
    return response;
  }
}
