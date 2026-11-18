import {
  aAddress,
  aRecord,
  DnsPacketError,
  decodePacket,
  encodePacket,
  TYPE,
} from "./dns-packet";

describe("dns-packet", () => {
  it("round-trips a response with an A record", () => {
    const packet = decodePacket(
      encodePacket({
        id: 7,
        isResponse: true,
        answers: [aRecord("monize.local", "192.168.1.23", 120)],
      }),
    );
    expect(packet.id).toBe(7);
    expect(packet.isResponse).toBe(true);
    expect(packet.answers).toHaveLength(1);
    expect(packet.answers[0]).toMatchObject({
      name: "monize.local",
      type: TYPE.A,
      cacheFlush: true,
      ttl: 120,
    });
    expect(aAddress(packet.answers[0] as never)).toBe("192.168.1.23");
  });

  it("reads a compressed name, lower-cased", () => {
    // Question "Monize.local" A, then an answer whose name is a pointer to it.
    const name = Buffer.from([
      6,
      ...Buffer.from("Monize"),
      5,
      ...Buffer.from("local"),
      0,
    ]);
    const header = Buffer.from([0, 1, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
    const question = Buffer.concat([name, Buffer.from([0, 1, 0, 1])]);
    const answer = Buffer.from([
      0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 120, 0, 4, 10, 0, 0, 9,
    ]);
    const packet = decodePacket(Buffer.concat([header, question, answer]));
    expect(packet.questions[0]?.name).toBe("monize.local");
    expect(packet.answers[0]?.name).toBe("monize.local");
    expect(aAddress(packet.answers[0] as never)).toBe("10.0.0.9");
  });

  it("refuses a pointer that points forwards or at itself", () => {
    const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    const loop = Buffer.from([0xc0, 12, 0, 1, 0, 1]);
    expect(() => decodePacket(Buffer.concat([header, loop]))).toThrow(
      DnsPacketError,
    );
  });

  it("refuses a packet that ends early", () => {
    expect(() => decodePacket(Buffer.from([0, 0, 0, 0, 0, 1]))).toThrow(
      DnsPacketError,
    );
    const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(() =>
      decodePacket(Buffer.concat([header, Buffer.from([6, 1, 2])])),
    ).toThrow(DnsPacketError);
  });

  it("refuses a name longer than 255 bytes", () => {
    const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    const label = Buffer.from([63, ...Buffer.alloc(63, 0x61)]);
    const name = Buffer.concat([
      label,
      label,
      label,
      label,
      label,
      Buffer.from([0]),
    ]);
    expect(() =>
      decodePacket(Buffer.concat([header, name, Buffer.from([0, 1, 0, 1])])),
    ).toThrow(DnsPacketError);
  });

  it("only writes IPv4 into an A record", () => {
    expect(() => aRecord("monize.local", "fd00::1", 120)).toThrow(
      DnsPacketError,
    );
  });
});
