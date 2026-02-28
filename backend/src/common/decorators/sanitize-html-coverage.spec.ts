import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { CreateCustomReportDto } from "../../reports/dto/create-custom-report.dto";
import { CreateCurrencyDto } from "../../currencies/dto/create-currency.dto";
import { CreatePatDto } from "../../auth/dto/create-pat.dto";
import { CreateSecurityDto } from "../../securities/dto/create-security.dto";
import {
  OverrideSplitDto,
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
} from "../../scheduled-transactions/dto/scheduled-transaction-override.dto";

describe("SanitizeHtml coverage on newly protected DTOs", () => {
  describe("CreateCustomReportDto", () => {
    it("strips HTML from name", () => {
      const dto = plainToInstance(CreateCustomReportDto, {
        name: "<script>alert(1)</script>",
      });
      expect(dto.name).toBe("scriptalert(1)/script");
    });

    it("strips HTML from description", () => {
      const dto = plainToInstance(CreateCustomReportDto, {
        name: "Report",
        description: "<img src=x onerror=alert(1)>",
      });
      expect(dto.description).toBe("img src=x onerror=alert(1)");
    });

    it("strips HTML from icon", () => {
      const dto = plainToInstance(CreateCustomReportDto, {
        name: "Report",
        icon: "<b>bold</b>",
      });
      expect(dto.icon).toBe("bbold/b");
    });
  });

  describe("CreateCurrencyDto", () => {
    it("strips HTML from name", () => {
      const dto = plainToInstance(CreateCurrencyDto, {
        code: "XSS",
        name: "<script>steal()</script>",
        symbol: "$",
      });
      expect(dto.name).toBe("scriptsteal()/script");
    });

    it("strips HTML from symbol", () => {
      const dto = plainToInstance(CreateCurrencyDto, {
        code: "XSS",
        name: "Test",
        symbol: "<b>$</b>",
      });
      expect(dto.symbol).toBe("b$/b");
    });
  });

  describe("CreatePatDto", () => {
    it("strips HTML from name", () => {
      const dto = plainToInstance(CreatePatDto, {
        name: "<img src=x>My Token",
      });
      expect(dto.name).toBe("img src=xMy Token");
    });
  });

  describe("CreateSecurityDto", () => {
    it("strips HTML from securityType", () => {
      const dto = plainToInstance(CreateSecurityDto, {
        symbol: "AAPL",
        name: "Apple",
        currencyCode: "USD",
        securityType: "<script>xss</script>",
      });
      expect(dto.securityType).toBe("scriptxss/script");
    });

    it("strips HTML from exchange", () => {
      const dto = plainToInstance(CreateSecurityDto, {
        symbol: "AAPL",
        name: "Apple",
        currencyCode: "USD",
        exchange: "<b>NYSE</b>",
      });
      expect(dto.exchange).toBe("bNYSE/b");
    });
  });

  describe("OverrideSplitDto", () => {
    it("strips HTML from memo", () => {
      const dto = plainToInstance(OverrideSplitDto, {
        amount: 100,
        memo: "<script>alert(1)</script>",
      });
      expect(dto.memo).toBe("scriptalert(1)/script");
    });
  });

  describe("CreateScheduledTransactionOverrideDto", () => {
    it("strips HTML from description", () => {
      const dto = plainToInstance(CreateScheduledTransactionOverrideDto, {
        originalDate: "2026-01-01",
        overrideDate: "2026-01-02",
        description: "<div>test</div>",
      });
      expect(dto.description).toBe("divtest/div");
    });
  });

  describe("UpdateScheduledTransactionOverrideDto", () => {
    it("strips HTML from description", () => {
      const dto = plainToInstance(UpdateScheduledTransactionOverrideDto, {
        description: "<span onclick=alert(1)>click</span>",
      });
      expect(dto.description).toBe("span onclick=alert(1)click/span");
    });
  });
});
