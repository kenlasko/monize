import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPayeeFromName } from './payee-create';

const findInactiveByName = vi.fn();
const create = vi.fn();
vi.mock('./payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./payees')>()),
  payeesApi: {
    findInactiveByName: (...args: unknown[]) => findInactiveByName(...args),
    create: (...args: unknown[]) => create(...args),
  },
}));

describe('createPayeeFromName', () => {
  beforeEach(() => {
    findInactiveByName.mockReset().mockResolvedValue(null);
    create.mockReset().mockImplementation(async ({ name }: { name: string }) => ({ id: 'p-new', name }));
  });

  it('creates a payee under the trimmed name when no inactive one has it', async () => {
    await expect(createPayeeFromName('  Corner Cafe ')).resolves.toEqual({
      kind: 'created',
      payee: { id: 'p-new', name: 'Corner Cafe' },
    });
    expect(findInactiveByName).toHaveBeenCalledWith('Corner Cafe');
    expect(create).toHaveBeenCalledWith({ name: 'Corner Cafe' });
  });

  it('defers the contact lookup only when the caller runs it', async () => {
    await createPayeeFromName('Corner Cafe', { deferContactLookup: true });
    expect(create).toHaveBeenCalledWith({ name: 'Corner Cafe', deferContactLookup: true });
  });

  it('offers an inactive payee of that name back and writes nothing', async () => {
    const inactive = { id: 'p-old', name: 'Corner Cafe', isActive: false };
    findInactiveByName.mockResolvedValue(inactive);
    await expect(createPayeeFromName('Corner Cafe')).resolves.toEqual({ kind: 'inactive', payee: inactive });
    expect(create).not.toHaveBeenCalled();
  });

  it('does nothing for a blank name', async () => {
    await expect(createPayeeFromName('   ')).resolves.toBeNull();
    expect(findInactiveByName).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
