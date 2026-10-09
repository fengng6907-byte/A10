import { NextRequest, NextResponse } from 'next/server';
import { createAuthorization, stateHash } from '@/stocks/moomoo-auth';
import { stockDb } from '@/stocks/store';

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    const db = stockDb();
    const authorization = await createAuthorization(db, request.nextUrl.origin);
    const response = NextResponse.redirect(authorization.url);
    response.cookies.set('moomoo_oauth_state', stateHash(authorization.state), { httpOnly: true, sameSite: 'lax', secure: request.nextUrl.protocol === 'https:', path: '/api/stocks/moomoo/oauth/callback', maxAge: 300 });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start Moomoo OAuth';
    return NextResponse.redirect(new URL(`/stocks?moomoo=error&detail=${encodeURIComponent(message.slice(0, 180))}`, request.url));
  }
}
