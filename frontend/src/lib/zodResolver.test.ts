import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodResolver } from './zodResolver';

describe('zodResolver', () => {
  const schema = z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Invalid email'),
  });

  const resolver = zodResolver(schema);

  it('returns parsed values and empty errors for valid input', async () => {
    const result = await resolver(
      { name: 'Alice', email: 'alice@example.com' },
      undefined as any,
      {} as any,
    );
    expect(result.values).toEqual({ name: 'Alice', email: 'alice@example.com' });
    expect(result.errors).toEqual({});
  });

  it('returns field errors for invalid input', async () => {
    const result = await resolver({ name: '', email: 'bad' }, undefined as any, {} as any);
    expect(result.errors).toHaveProperty('name');
    expect((result.errors as any).name.message).toBe('Name is required');
    expect(result.errors).toHaveProperty('email');
    expect((result.errors as any).email.message).toBe('Invalid email');
  });

  it('returns empty values object on validation failure', async () => {
    const result = await resolver({ name: '', email: 'bad' }, undefined as any, {} as any);
    expect(result.values).toEqual({});
  });

  it('handles nested path errors with dot notation', async () => {
    const nestedSchema = z.object({
      address: z.object({
        street: z.string().min(1, 'Street is required'),
      }),
    });
    const nestedResolver = zodResolver(nestedSchema);
    const result = await nestedResolver(
      { address: { street: '' } },
      undefined as any,
      {} as any,
    );
    expect(result.errors).toHaveProperty('address.street');
    expect((result.errors as any)['address.street'].message).toBe('Street is required');
  });

  it('re-throws non-Zod errors', async () => {
    const throwingSchema = z.object({ name: z.string() }).transform(() => {
      throw new Error('Custom runtime error');
    });
    const throwingResolver = zodResolver(throwingSchema as any);
    await expect(throwingResolver({ name: 'test' }, undefined as any, {} as any)).rejects.toThrow(
      'Custom runtime error',
    );
  });

  it('works with optional fields', async () => {
    const optionalSchema = z.object({
      name: z.string().min(1),
      nickname: z.string().optional(),
    });
    const optionalResolver = zodResolver(optionalSchema);
    const result = await optionalResolver({ name: 'Bob' }, undefined as any, {} as any);
    expect(result.values).toEqual({ name: 'Bob' });
    expect(result.errors).toEqual({});
  });
});
