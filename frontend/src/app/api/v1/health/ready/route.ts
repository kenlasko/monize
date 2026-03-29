import { NextResponse } from 'next/server';

export async function GET() {
  const apiUrl = process.env.INTERNAL_API_URL || 'http://localhost:3001';
  try {
    const res = await fetch(`${apiUrl}/api/v1/health/ready`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return NextResponse.json({ status: 'not ready' }, { status: 503 });
    }
    return NextResponse.json({ status: 'ok' });
  } catch {
    return NextResponse.json({ status: 'not ready' }, { status: 503 });
  }
}
