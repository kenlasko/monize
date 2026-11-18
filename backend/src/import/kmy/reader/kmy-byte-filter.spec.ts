import { filterKmyBytes } from "./kmy-byte-filter";

const f = (...bytes: number[]) => [...filterKmyBytes(Buffer.from(bytes))];
const LEAD = 0xc3;
const LEAD2 = 0xe2;
const CONT = 0xa9;

describe("filterKmyBytes (spec 4.4 truth table)", () => {
  it("ASCII and TAB/LF/CR in state F or S: emitted", () => {
    expect(f(0x41, 0x09, 0x0a, 0x0d, 0x7f)).toEqual([
      0x41, 0x09, 0x0a, 0x0d, 0x7f,
    ]);
    // S: after a full sequence
    expect(f(LEAD, CONT, 0x41)).toEqual([LEAD, CONT, 0x41]);
  });

  it("ASCII in state L: the lead is dropped, then the byte is emitted", () => {
    expect(f(LEAD, 0x41)).toEqual([0x41]);
    expect(f(0x31, LEAD, 0x0a)).toEqual([0x31, 0x0a]);
  });

  it("other control in state F or S: dropped", () => {
    expect(f(0x41, 0x00, 0x1f, 0x42)).toEqual([0x41, 0x42]);
    expect(f(LEAD, CONT, 0x01, 0x42)).toEqual([LEAD, CONT, 0x42]);
  });

  it("other control in state L: the lead is dropped and nothing emitted", () => {
    expect(f(LEAD, 0x01, 0x42)).toEqual([0x42]);
  });

  it("lead in state F or S: emitted", () => {
    expect(f(LEAD)).toEqual([LEAD]);
    expect(f(LEAD, CONT, LEAD2, CONT, CONT)).toEqual([
      LEAD,
      CONT,
      LEAD2,
      CONT,
      CONT,
    ]);
  });

  it("lead in state L: replaces the previous lead", () => {
    expect(f(LEAD, LEAD2, CONT, CONT)).toEqual([LEAD2, CONT, CONT]);
    expect(f(0xc0, 0xc1, 0xff)).toEqual([0xff]);
  });

  it("continuation in state L or S: emitted", () => {
    expect(f(LEAD, CONT)).toEqual([LEAD, CONT]);
    expect(f(LEAD2, CONT, CONT, CONT)).toEqual([LEAD2, CONT, CONT, CONT]);
  });

  it("continuation in state F: dropped", () => {
    expect(f(CONT)).toEqual([]);
    expect(f(0x41, CONT, 0x42)).toEqual([0x41, 0x42]);
  });

  it("returns a new buffer and leaves the input alone", () => {
    const input = Buffer.from([0x41, 0x00, 0x42]);
    const out = filterKmyBytes(input);
    expect(out).not.toBe(input);
    expect([...input]).toEqual([0x41, 0x00, 0x42]);
    expect(out.buffer.byteLength).toBeGreaterThanOrEqual(out.length);
    expect(out.length).toBe(2);
  });

  it("an empty buffer stays empty", () => {
    expect(filterKmyBytes(Buffer.alloc(0)).length).toBe(0);
  });

  it("is applied to the whole buffer, so a sequence spanning 64 KB survives", () => {
    const size = 64 * 1024;
    const input = Buffer.alloc(size + 2, 0x41);
    input[size - 1] = LEAD;
    input[size] = CONT;
    const out = filterKmyBytes(input);
    expect(out.length).toBe(input.length);
    expect(out[size - 1]).toBe(LEAD);
    expect(out[size]).toBe(CONT);
    expect(out.toString("utf8").includes("�")).toBe(false);
  });
});
