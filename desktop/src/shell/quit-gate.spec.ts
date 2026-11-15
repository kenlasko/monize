import { closeDecision, createQuitGate } from "./quit-gate";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function event() {
  let prevented = 0;
  return {
    preventDefault: () => {
      prevented += 1;
    },
    get prevented() {
      return prevented;
    },
  };
}

describe("createQuitGate", () => {
  it("holds the quit until the shutdown resolves, then exits once", async () => {
    let finish: () => void = () => undefined;
    const exits: number[] = [];
    let begun = 0;
    let shutdowns = 0;
    const gate = createQuitGate({
      shutdown: () => {
        shutdowns += 1;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      exit: (code) => exits.push(code),
      onBegin: () => {
        begun += 1;
      },
    });
    expect(gate.quitting).toBe(false);

    const first = event();
    gate.beforeQuit(first);
    const second = event();
    gate.beforeQuit(second);
    await tick();
    expect(first.prevented).toBe(1);
    expect(second.prevented).toBe(1);
    expect(shutdowns).toBe(1);
    expect(begun).toBe(1);
    expect(exits).toEqual([]);
    expect(gate.quitting).toBe(true);

    finish();
    await tick();
    expect(exits).toEqual([0]);

    const late = event();
    gate.beforeQuit(late);
    expect(late.prevented).toBe(0);
  });

  it("still exits, non-zero, if the shutdown rejects", async () => {
    const exits: number[] = [];
    const gate = createQuitGate({
      shutdown: () => Promise.reject(new Error("boom")),
      exit: (code) => exits.push(code),
    });
    gate.beforeQuit(event());
    await tick();
    expect(exits).toEqual([1]);
  });
});

describe("closeDecision", () => {
  it("hides to the tray only when there is one and the app is not quitting", () => {
    expect(closeDecision({ quitting: false, trayAvailable: true })).toBe(
      "hide",
    );
    expect(closeDecision({ quitting: true, trayAvailable: true })).toBe(
      "close",
    );
    expect(closeDecision({ quitting: false, trayAvailable: false })).toBe(
      "close",
    );
  });
});
