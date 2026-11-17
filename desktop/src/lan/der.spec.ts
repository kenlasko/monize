import {
  bitString,
  integer,
  ipBytes,
  oid,
  prefixMask,
  sequence,
  time,
  tlv,
} from "./der";

const hex = (buffer: Buffer): string => buffer.toString("hex");

describe("der", () => {
  it("encodes integers as positive, minimal and padded", () => {
    expect(hex(integer(0))).toBe("020100");
    expect(hex(integer(2))).toBe("020102");
    expect(hex(integer(128))).toBe("02020080");
    expect(hex(integer(Buffer.from([0, 0, 0x7f])))).toBe("02017f");
    expect(hex(integer(Buffer.from([0xff])))).toBe("020200ff");
    expect(() => integer(-1)).toThrow(RangeError);
  });

  it("encodes the ECDSA-with-SHA256 object identifier", () => {
    expect(hex(oid("1.2.840.10045.4.3.2"))).toBe("06082a8648ce3d040302");
    expect(hex(oid("2.5.29.30"))).toBe("0603551d1e");
  });

  it("uses the long length form past 127 bytes", () => {
    expect(hex(tlv(0x04, Buffer.alloc(200)).subarray(0, 3))).toBe("0481c8");
    expect(hex(tlv(0x04, Buffer.alloc(300)).subarray(0, 4))).toBe("0482012c");
  });

  it("writes UTCTime through 2049 and GeneralizedTime after", () => {
    expect(time(new Date("2036-11-17T12:00:00Z")).toString("latin1")).toBe(
      "\x17\x0d361117120000Z",
    );
    expect(time(new Date("2050-01-01T00:00:00Z")).toString("latin1")).toBe(
      "\x18\x0f20500101000000Z",
    );
  });

  it("prefixes a bit string with its unused-bit count", () => {
    expect(hex(bitString(Buffer.from([0x06]), 1))).toBe("03020106");
    expect(() => bitString(Buffer.alloc(1), 8)).toThrow(RangeError);
  });

  it("nests sequences", () => {
    expect(hex(sequence(integer(1), integer(2)))).toBe("3006020101020102");
  });

  it("turns addresses into their network bytes", () => {
    expect(hex(ipBytes("192.168.1.5"))).toBe("c0a80105");
    expect(hex(ipBytes("::1"))).toBe("00000000000000000000000000000001");
    expect(hex(ipBytes("fd12:3456::23"))).toBe(
      "fd123456000000000000000000000023",
    );
    expect(hex(ipBytes("fe80::1%eth0"))).toBe(
      "fe800000000000000000000000000001",
    );
    expect(hex(ipBytes("::ffff:192.168.1.2"))).toBe(
      "00000000000000000000ffffc0a80102",
    );
    expect(() => ipBytes("monize.local")).toThrow(RangeError);
  });

  it("builds netmasks from prefix lengths", () => {
    expect(hex(prefixMask(12, 4))).toBe("fff00000");
    expect(hex(prefixMask(7, 16))).toBe("fe000000000000000000000000000000");
    expect(hex(prefixMask(0, 4))).toBe("00000000");
    expect(() => prefixMask(33, 4)).toThrow(RangeError);
  });
});
