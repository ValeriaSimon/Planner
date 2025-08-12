
import { NextResponse } from 'next/server';

export const runtime = 'edge'; // be explicit

// Protect everything except Next internals & static assets
export const config = {
  matcher: [
    '/((?!_next/|favicon.ico|robots.txt|sitemap.xml|images/|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map|txt)).*)'
  ],
};

function decodeBasic(authHeader) {
  try {
    const [, b64] = authHeader.split(' ');
    const decoded = atob(b64); // available in Edge
    const i = decoded.indexOf(':');
    return [decoded.slice(0, i), decoded.slice(i + 1)];
  } catch {
    return [null, null];
  }
}

export function middleware(req) {
  const USER = process.env.BASIC_USER ?? '';
  const PASS = process.env.BASIC_PASS ?? '';

  if (!USER || !PASS) {
    return new NextResponse('Auth required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Planner"' },
    });
  }

  const auth = req.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    const [u, p] = decodeBasic(auth);
    if (u === USER && p === PASS) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Auth required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Planner"' },
  });
}
