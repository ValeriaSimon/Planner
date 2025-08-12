import { NextResponse } from 'next/server';

const USER = process.env.BASIC_USER;
const PASS = process.env.BASIC_PASS;

// Allow Next internals & static assets; protect everything else
export const config = {
  matcher: [
    '/((?!_next|favicon.ico|robots.txt|sitemap.xml|images|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|css|js|map)).*)'
  ],
};

export function middleware(req) {
  const auth = req.headers.get('authorization');
  if (auth) {
    const [scheme, encoded] = auth.split(' ');
    if (scheme === 'Basic') {
      const [u, p] = atob(encoded).split(':');
      if (u === USER && p === PASS) return NextResponse.next();
    }
  }
  return new NextResponse('Auth required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Planner"' },
  });
}
