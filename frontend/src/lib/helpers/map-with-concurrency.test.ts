import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './map-with-concurrency';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('mapWithConcurrency', () => {
  it('keeps the items order whatever order the calls finish in', async () => {
    const delays = [30, 5, 15, 0];
    const result = await mapWithConcurrency(delays, 2, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return i;
    });
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it('never has more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  it('rejects with the first failure and starts nothing after it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4], 1, async (i) => {
        started.push(i);
        if (i === 1) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]);
  });

  it('answers an empty list with an empty list', async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});
