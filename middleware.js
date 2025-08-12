import { NextResponse } from 'next/server';

export const config = {
  // protect everything except Next internals & static assets
  matcher: [
    '/((?!_next/|favicon.ico|robots.txt|sitemap.xml|images/|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map)).*)'
  ],
};

export function middleware(req) {
  const USER = process.env.BASIC_USER ?? '';
  const PASS = process.env.BASIC_PASS ?? '';

  // if creds not set, just deny (but don't crash)
  if (!USER || !PASS) {
    return new NextResponse('Auth required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Planner"' },
    });
  }

  const auth = req.headers.get('authorization') || '';

  if (auth.startsWith('Basic ')) {
    try {
      const [, hash] = auth.split(' ');
      // atob should exist in Edge, but guard anyway
      const decoded = typeof atob === 'function' ? atob(hash) : '';
      const [u, p] = decoded.split(':');
      if (u === USER && p === PASS) {
        return NextResponse.next();
      }
    } catch {
      // fall through to 401
    }
  }

  return new NextResponse('Auth required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Planner"' },
  });
}