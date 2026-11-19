import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@/test/render';
import { useInstitutionLogos } from './useInstitutionLogos';

const { getAll } = vi.hoisted(() => ({ getAll: vi.fn() }));
vi.mock('@/lib/institutions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/institutions')>()),
  institutionsApi: { getAll },
}));

describe('useInstitutionLogos', () => {
  beforeEach(() => {
    getAll.mockReset();
  });

  it('maps each institution to the logo data a picker draws', async () => {
    getAll.mockResolvedValue([
      { id: 'i-1', name: 'Big Bank', hasLogo: true, website: 'https://bank.example' },
    ]);
    const { result } = renderHook(() => useInstitutionLogos());
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get('i-1')).toEqual({ id: 'i-1', name: 'Big Bank', hasLogo: true });
  });

  it('stays empty when the read fails, so pickers draw the type icon instead', async () => {
    getAll.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useInstitutionLogos());
    await waitFor(() => expect(getAll).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });
});
