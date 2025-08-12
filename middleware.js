// middleware.js (temporary)
import { NextResponse } from 'next/server';
export const config = { matcher: ['/((?!_next/|.*\\.).*)'] };
export function middleware() { return NextResponse.next(); }
