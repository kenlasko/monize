import { EntityManager } from "typeorm";
import {
  loadReportPlaces,
  reportFigure,
  reportFigureOrNull,
  reportPlacesFor,
} from "./report-figure";
import { roundMoney } from "./round.util";

describe("report figures (docs/specs/report-rounding-and-aggregation.md section 6)", () => {
  describe("reportFigure", () => {
    it("rounds a calculated 2.50498 once, to 2.50, not through 2.5050 to 2.51", () => {
      expect(reportFigure(2.50498, 2)).toBe(2.5);
      expect(roundMoney(roundMoney(2.50498), 2)).toBe(2.51);
    });

    it("rounds half away from zero for both signs", () => {
      expect(reportFigure(0.005, 2)).toBe(0.01);
      expect(reportFigure(-0.005, 2)).toBe(-0.01);
      expect(reportFigure(1234.5, 0)).toBe(1235);
      expect(reportFigure(-1234.5, 0)).toBe(-1235);
    });

    it("keeps a coin's eight places", () => {
      expect(reportFigure(0.123456785, 8)).toBe(0.12345679);
    });

    it("keeps an unknown figure unknown", () => {
      expect(reportFigureOrNull(null, 2)).toBeNull();
      expect(reportFigureOrNull(2.50498, 2)).toBe(2.5);
    });
  });

  describe("reportPlacesFor", () => {
    it("reads an ISO code's minor unit, never its row", () => {
      const rows = new Map([
        ["USD", 4],
        ["JPY", 2],
      ]);
      expect(reportPlacesFor("USD", rows)).toBe(2);
      expect(reportPlacesFor("jpy", rows)).toBe(0);
      expect(reportPlacesFor("BHD", rows)).toBe(3);
    });

    it("reads a non-ISO code's row, else 2, never past eight", () => {
      const rows = new Map([
        ["BTC", 8],
        ["XYZ", 12],
      ]);
      expect(reportPlacesFor("BTC", rows)).toBe(8);
      expect(reportPlacesFor("XYZ", rows)).toBe(8);
      expect(reportPlacesFor("QQQ", rows)).toBe(2);
    });
  });

  describe("loadReportPlaces", () => {
    const managerWith = (
      rows: Array<{ code: string; decimalPlaces: number }>,
    ) => {
      const find = jest.fn().mockResolvedValue(rows);
      const manager = {
        getRepository: jest.fn().mockReturnValue({ find }),
      } as unknown as EntityManager;
      return { manager, find };
    };

    it("reads nothing for an ISO code", async () => {
      const { manager, find } = managerWith([]);
      expect(await loadReportPlaces(manager, "JPY")).toBe(0);
      expect(find).not.toHaveBeenCalled();
    });

    it("reads a coin's row", async () => {
      const { manager, find } = managerWith([
        { code: "BTC", decimalPlaces: 8 },
      ]);
      expect(await loadReportPlaces(manager, "BTC")).toBe(8);
      expect(find).toHaveBeenCalledTimes(1);
    });
  });
});
