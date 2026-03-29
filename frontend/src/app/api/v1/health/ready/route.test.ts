import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';

const originalEnv = process.env.INTERNAL_API_URL;

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.INTERNAL_API_URL = 'http://backend:3000';
});

describe('Health Ready Route', () => {
  it('returns 200 when backend is healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://backend:3000/api/v1/health/ready',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns 503 when backend returns non-ok status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Service Unavailable', { status: 503 }),
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: 'not ready' });
  });

  it('returns 503 when backend is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ status: 'not ready' });
  });

  it('uses default URL when INTERNAL_API_URL is not set', async () => {
    delete process.env.INTERNAL_API_URL;

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );

    await GET();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:3001/api/v1/health/ready',
      expect.any(Object),
    );

    process.env.INTERNAL_API_URL = originalEnv;
  });
});
