import { setImmediate as yieldToEventLoop } from "node:timers/promises";

/**
 * A long mapping run written once and driven two ways (B2). A mapper is a
 * generator that `yield`s at safe points (between phases, every
 * `STEP_EVERY` items of a loop) and returns its result; `runSteps` drives it
 * straight through, synchronously, for the specs and the pure call sites, and
 * `runStepsYielding` hands the event loop back whenever `budgetMs` has passed
 * since it last did, so a large file is mapped without blocking every other
 * request for seconds. Both run the same code in the same order, so they give
 * the same result.
 */
export type Steps<T> = Generator<void, T, void>;

/** Loop items between yield points. */
export const STEP_EVERY = 500;

export function runSteps<T>(steps: Steps<T>): T {
  let step = steps.next();
  while (!step.done) {
    step = steps.next();
  }
  return step.value;
}

export async function runStepsYielding<T>(
  steps: Steps<T>,
  budgetMs = 20,
): Promise<T> {
  let since = Date.now();
  let step = steps.next();
  while (!step.done) {
    if (Date.now() - since >= budgetMs) {
      await yieldToEventLoop();
      since = Date.now();
    }
    step = steps.next();
  }
  return step.value;
}
