import { manifest } from "../adapters/pl/pl-test-input";
import { benchmarkReadsOf, readsBenchmark } from "./benchmark-reads";

describe("benchmarkReadsOf", () => {
  it("names the inflation benchmark of an EDO rate rule, read as a RATE_FRACTION", () => {
    expect(benchmarkReadsOf(manifest("edo1036"))).toEqual([
      { benchmarkId: "PL_CPI_GUS_YOY", role: "RATE", unit: "RATE_FRACTION" },
    ]);
  });

  it("reads no benchmark for a fixed rate", () => {
    expect(benchmarkReadsOf(manifest("ots0127"))).toEqual([]);
  });

  it("answers whether a given benchmark is read", () => {
    const edo = manifest("edo1036");
    expect(readsBenchmark(edo, "PL_CPI_GUS_YOY")).toBe(true);
    expect(readsBenchmark(edo, "PL_NBP_REFERENCE")).toBe(false);
  });
});
