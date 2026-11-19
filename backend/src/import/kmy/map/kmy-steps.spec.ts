import { STEP_EVERY, Steps, runSteps, runStepsYielding } from "./kmy-steps";

function* counting(n: number): Steps<number> {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += i;
    if (i % STEP_EVERY === 0) {
      yield;
    }
  }
  return total;
}

describe("kmy-steps (B2)", () => {
  it("gives the same result driven straight through and yielding", async () => {
    expect(runSteps(counting(10_000))).toBe(49_995_000);
    await expect(runStepsYielding(counting(10_000))).resolves.toBe(49_995_000);
  });

  it("hands the event loop back once its budget is spent", async () => {
    function* slow(): Steps<string> {
      for (let i = 0; i < 6; i++) {
        const until = Date.now() + 5;
        while (Date.now() < until) {
          // busy
        }
        yield;
      }
      return "done";
    }
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    try {
      await runStepsYielding(slow(), 1);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
