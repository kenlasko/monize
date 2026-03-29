import { describe, it, expect } from 'vitest';
import { GET } from './route';

describe('Health Live Route', () => {
  it('returns 200 with status ok', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok' });
  });
});
