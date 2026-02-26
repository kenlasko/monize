import "reflect-metadata";
import { validate } from "class-validator";
import { IsSafeUrl } from "./safe-url.validator";

// Mock dns module before importing the validator class
jest.mock("dns", () => ({
  resolve4: jest.fn((_hostname, cb) => cb(null, ["93.184.216.34"])),
  resolve6: jest.fn((_hostname, cb) => cb(null, [])),
}));

import * as dns from "dns";

const mockResolve4 = dns.resolve4 as unknown as jest.Mock;
const mockResolve6 = dns.resolve6 as unknown as jest.Mock;

class TestDto {
  @IsSafeUrl()
  baseUrl: string;
}

function buildDto(url: string): TestDto {
  const dto = new TestDto();
  dto.baseUrl = url;
  return dto;
}

async function expectValid(url: string) {
  const errors = await validate(buildDto(url));
  expect(errors).toHaveLength(0);
}

async function expectInvalid(url: string) {
  const errors = await validate(buildDto(url));
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0].property).toBe("baseUrl");
}

describe("IsSafeUrl validator", () => {
  beforeEach(() => {
    // Default: DNS resolves to a public IP
    mockResolve4.mockImplementation((_h, cb) => cb(null, ["93.184.216.34"]));
    mockResolve6.mockImplementation((_h, cb) => cb(null, []));
  });

  describe("valid external URLs", () => {
    it("accepts https URL", async () => {
      await expectValid("https://api.openai.com/v1");
    });

    it("accepts http URL", async () => {
      await expectValid("http://example.com");
    });

    it("accepts URL with port", async () => {
      await expectValid("https://api.example.com:8080/path");
    });

    it("accepts URL with path and query", async () => {
      await expectValid("https://example.com/api?key=value");
    });

    it("accepts public IP", async () => {
      await expectValid("https://93.184.216.34/api");
    });
  });

  describe("non-string and malformed inputs", () => {
    it("rejects non-string value", async () => {
      const dto = new TestDto();
      (dto as any).baseUrl = 12345;
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects malformed URL", async () => {
      await expectInvalid("not-a-url");
    });

    it("rejects empty string", async () => {
      await expectInvalid("");
    });
  });

  describe("blocked protocols", () => {
    it("rejects ftp://", async () => {
      await expectInvalid("ftp://example.com/file");
    });

    it("rejects file://", async () => {
      await expectInvalid("file:///etc/passwd");
    });

    it("rejects javascript:", async () => {
      await expectInvalid("javascript:alert(1)");
    });
  });

  describe("blocked hostnames", () => {
    it("rejects localhost", async () => {
      await expectInvalid("https://localhost/api");
    });

    it("rejects metadata.google.internal", async () => {
      await expectInvalid("http://metadata.google.internal/computeMetadata");
    });

    it("rejects 169.254.169.254 (AWS metadata)", async () => {
      await expectInvalid("http://169.254.169.254/latest/meta-data");
    });

    it("rejects metadata", async () => {
      await expectInvalid("http://metadata/api");
    });
  });

  describe("blocked suffixes", () => {
    it("rejects .internal suffix", async () => {
      await expectInvalid("https://my-service.internal/api");
    });

    it("rejects .local suffix", async () => {
      await expectInvalid("https://printer.local/status");
    });

    it("rejects .localhost suffix", async () => {
      await expectInvalid("https://app.localhost/api");
    });

    it("rejects bare 'internal' hostname", async () => {
      await expectInvalid("https://internal/api");
    });

    it("rejects bare 'local' hostname", async () => {
      await expectInvalid("https://local/api");
    });
  });

  describe("private IP ranges", () => {
    it("rejects 127.0.0.1 (loopback)", async () => {
      await expectInvalid("https://127.0.0.1/api");
    });

    it("rejects 127.x.x.x range", async () => {
      await expectInvalid("https://127.255.0.1/api");
    });

    it("rejects 10.x.x.x (private class A)", async () => {
      await expectInvalid("https://10.0.0.1/api");
    });

    it("rejects 172.16.x.x (private class B)", async () => {
      await expectInvalid("https://172.16.0.1/api");
    });

    it("rejects 172.31.x.x (private class B upper)", async () => {
      await expectInvalid("https://172.31.255.255/api");
    });

    it("allows 172.15.x.x (not private)", async () => {
      await expectValid("https://172.15.0.1/api");
    });

    it("rejects 192.168.x.x (private class C)", async () => {
      await expectInvalid("https://192.168.1.1/api");
    });

    it("rejects 0.x.x.x", async () => {
      await expectInvalid("https://0.0.0.0/api");
    });

    it("rejects 169.254.x.x (link-local)", async () => {
      await expectInvalid("https://169.254.1.1/api");
    });
  });

  describe("alternative IP encodings (SSRF bypass prevention)", () => {
    it("rejects decimal IP for 127.0.0.1 (2130706433)", async () => {
      await expectInvalid("https://2130706433/api");
    });

    it("rejects decimal IP for 10.0.0.1 (167772161)", async () => {
      await expectInvalid("https://167772161/api");
    });

    it("rejects hex IP for 127.0.0.1 (0x7f000001)", async () => {
      await expectInvalid("https://0x7f000001/api");
    });

    it("rejects hex IP for 10.0.0.1 (0x0a000001)", async () => {
      await expectInvalid("https://0x0a000001/api");
    });

    it("rejects octal IP for 127.0.0.1 (0177.0.0.1)", async () => {
      await expectInvalid("https://0177.0.0.1/api");
    });
  });

  describe("URLs with credentials", () => {
    it("rejects URL with username", async () => {
      await expectInvalid("https://admin@example.com/api");
    });

    it("rejects URL with username and password", async () => {
      await expectInvalid("https://admin:password@example.com/api");
    });
  });

  describe("DNS resolution blocking", () => {
    it("rejects hostname that resolves to private IP", async () => {
      mockResolve4.mockImplementation((_h, cb) => cb(null, ["127.0.0.1"]));
      await expectInvalid("https://evil.example.com/api");
    });

    it("rejects hostname resolving to 10.x.x.x", async () => {
      mockResolve4.mockImplementation((_h, cb) => cb(null, ["10.0.0.5"]));
      await expectInvalid("https://evil.example.com/api");
    });

    it("rejects hostname resolving to 192.168.x.x", async () => {
      mockResolve4.mockImplementation((_h, cb) => cb(null, ["192.168.1.100"]));
      await expectInvalid("https://evil.example.com/api");
    });

    it("allows hostname resolving to public IP", async () => {
      mockResolve4.mockImplementation((_h, cb) => cb(null, ["93.184.216.34"]));
      await expectValid("https://api.example.com/v1");
    });

    it("allows hostname when DNS resolution fails", async () => {
      mockResolve4.mockImplementation((_h, cb) =>
        cb(new Error("ENOTFOUND"), null),
      );
      mockResolve6.mockImplementation((_h, cb) =>
        cb(new Error("ENOTFOUND"), null),
      );
      await expectValid("https://nonexistent-but-allowed.example.com/api");
    });

    it("rejects when all resolved IPs are private (mixed v4)", async () => {
      mockResolve4.mockImplementation((_h, cb) =>
        cb(null, ["10.0.0.1", "10.0.0.2"]),
      );
      await expectInvalid("https://multi.example.com/api");
    });

    it("allows when at least one resolved IP is public (mixed)", async () => {
      mockResolve4.mockImplementation((_h, cb) =>
        cb(null, ["93.184.216.34", "10.0.0.1"]),
      );
      await expectValid("https://mixed.example.com/api");
    });

    it("skips DNS check for direct IP addresses", async () => {
      mockResolve4.mockClear();
      await expectValid("https://93.184.216.34/api");
      expect(mockResolve4).not.toHaveBeenCalled();
    });
  });

  describe("default error message", () => {
    it("returns descriptive message", async () => {
      const errors = await validate(buildDto("ftp://evil.com"));
      expect(errors[0].constraints).toBeDefined();
      const message = Object.values(errors[0].constraints!)[0];
      expect(message).toContain("valid HTTP/HTTPS URL");
    });
  });
});
