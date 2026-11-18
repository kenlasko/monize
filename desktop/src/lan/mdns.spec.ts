import { createSocket } from "dgram";

import {
  aAddress,
  aRecord,
  decodePacket,
  encodePacket,
  Packet,
  TYPE,
} from "./dns-packet";
import {
  AdapterAddress,
  addressFacing,
  Endpoint,
  MDNS_GROUP,
  MDNS_PORT,
  MdnsError,
  MdnsTiming,
  MdnsTransport,
  startMdns,
} from "./mdns";
import { mdnsCandidates } from "./names";
import { udpTransport } from "./udp-transport";

const FAST: MdnsTiming = {
  probeIntervalMs: 5,
  announceIntervalMs: 5,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => 0,
};

/**
 * A network in memory. A multicast reaches every other device with an address
 * on the subnet of the adapter it left from; a unicast reaches its address.
 */
class Network {
  private readonly devices: {
    entries: [string, string][];
    handler: Handler;
  }[] = [];

  attach(...entries: [string, string][]): MdnsTransport & { sent: Packet[] } {
    const device = {
      entries,
      handler: (() => undefined) as Handler,
    };
    this.devices.push(device);
    const sent: Packet[] = [];
    return {
      sent,
      send: async (packet, to, via) => {
        try {
          sent.push(decodePacket(packet));
        } catch {
          // A spec's deliberately malformed packet.
        }
        const fromAddress = via ?? (entries[0] as [string, string])[0];
        const cidr = (entries.find(([address]) => address === fromAddress) ??
          entries[0]) as [string, string];
        const from: Endpoint = { address: fromAddress, port: MDNS_PORT };
        for (const other of this.devices) {
          if (other === device) continue;
          const reached =
            to.address === MDNS_GROUP
              ? other.entries.some(
                  ([address]) =>
                    addressFacing(address, [
                      { address: fromAddress, cidr: cidr[1] },
                    ]) !== null,
                )
              : other.entries.some(([address]) => address === to.address);
          if (reached) other.handler(packet, from);
        }
      },
      onMessage: (handler) => {
        device.handler = handler;
      },
      join: () => undefined,
      close: async () => {
        this.devices.splice(this.devices.indexOf(device), 1);
      },
    };
  }
}

type Handler = (packet: Buffer, from: Endpoint) => void;

function adapters(...entries: [string, string][]): () => AdapterAddress[] {
  return () => entries.map(([address, cidr]) => ({ address, cidr }));
}

/** A phone: asks a question and collects what comes back. */
function phone(network: Network, address: string, cidr: string) {
  const transport = network.attach([address, cidr]);
  const heard: Packet[] = [];
  transport.onMessage((packet) => {
    try {
      heard.push(decodePacket(packet));
    } catch {
      // Junk another spec device sent.
    }
  });
  return {
    heard,
    async ask(name: string, type: number = TYPE.A) {
      const query = encodePacket({
        isResponse: false,
        questions: [{ name, type, unicastResponse: false }],
      });
      await transport.send(
        query,
        { address: MDNS_GROUP, port: MDNS_PORT },
        null,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}

function answered(heard: readonly Packet[], name: string): string[] {
  return heard
    .flatMap((packet) => packet.answers)
    .filter((record) => record.name === name && record.ttl > 0)
    .map((record) => aAddress(record) as string);
}

describe("startMdns", () => {
  it("claims monize.local on a quiet network and answers for it", async () => {
    const network = new Network();
    const responder = await startMdns({
      transport: network.attach(["192.168.1.23", "192.168.1.23/24"]),
      candidates: mdnsCandidates(null),
      addresses: adapters(["192.168.1.23", "192.168.1.23/24"]),
      log: () => undefined,
      timing: FAST,
    });
    expect(responder.label).toBe("monize");
    const device = phone(network, "192.168.1.50", "192.168.1.50/24");
    await device.ask("monize.local");
    expect(answered(device.heard, "monize.local")).toContain("192.168.1.23");
    await responder.close();
  });

  it("takes monize-2 when another PC already holds monize", async () => {
    const network = new Network();
    const log: string[] = [];
    const first = await startMdns({
      transport: network.attach(["192.168.1.23", "192.168.1.23/24"]),
      candidates: mdnsCandidates(null),
      addresses: adapters(["192.168.1.23", "192.168.1.23/24"]),
      log: () => undefined,
      timing: FAST,
    });
    const second = await startMdns({
      transport: network.attach(["192.168.1.24", "192.168.1.24/24"]),
      candidates: mdnsCandidates(null),
      addresses: adapters(["192.168.1.24", "192.168.1.24/24"]),
      log: (line) => log.push(line),
      timing: FAST,
    });
    expect(first.label).toBe("monize");
    expect(second.label).toBe("monize-2");
    expect(log).toContain("mDNS: monize.local is taken on this network.");
    await second.close();
    await first.close();
  });

  it("keeps the label it claimed last time when it is free", async () => {
    const network = new Network();
    const responder = await startMdns({
      transport: network.attach(["192.168.1.23", "192.168.1.23/24"]),
      candidates: mdnsCandidates("monize-3"),
      addresses: adapters(["192.168.1.23", "192.168.1.23/24"]),
      log: () => undefined,
      timing: FAST,
    });
    expect(responder.label).toBe("monize-3");
    await responder.close();
  });

  it("answers each device with the adapter on its own subnet, and a stranger with nothing", async () => {
    const network = new Network();
    const responder = await startMdns({
      transport: network.attach(
        ["192.168.1.23", "192.168.1.23/24"],
        ["172.29.80.1", "172.29.80.1/20"],
      ),
      candidates: ["monize"],
      addresses: adapters(
        ["192.168.1.23", "192.168.1.23/24"],
        ["172.29.80.1", "172.29.80.1/20"],
      ),
      log: () => undefined,
      timing: FAST,
    });
    const wifi = phone(network, "192.168.1.50", "192.168.1.50/24");
    const wsl = phone(network, "172.29.80.9", "172.29.80.9/20");
    const stranger = phone(network, "10.9.9.9", "10.9.9.9/8");
    await wifi.ask("monize.local");
    await wsl.ask("monize.local");
    await stranger.ask("monize.local");
    expect(new Set(answered(wifi.heard, "monize.local"))).toEqual(
      new Set(["192.168.1.23"]),
    );
    expect(new Set(answered(wsl.heard, "monize.local"))).toEqual(
      new Set(["172.29.80.1"]),
    );
    expect(stranger.heard).toEqual([]);
    await responder.close();
  });

  it("ignores other names, AAAA queries and malformed packets", async () => {
    const network = new Network();
    const transport = network.attach(["192.168.1.23", "192.168.1.23/24"]);
    const responder = await startMdns({
      transport,
      candidates: ["monize"],
      addresses: adapters(["192.168.1.23", "192.168.1.23/24"]),
      log: () => undefined,
      timing: FAST,
    });
    // Let the second announcement go out first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = transport.sent.length;
    const device = phone(network, "192.168.1.50", "192.168.1.50/24");
    await device.ask("printer.local");
    await device.ask("monize.local", TYPE.AAAA);
    const junk = network.attach(["192.168.1.51", "192.168.1.51/24"]);
    await junk.send(
      Buffer.from([1, 2, 3]),
      { address: MDNS_GROUP, port: MDNS_PORT },
      null,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.sent.length).toBe(before);
    await device.ask("monize.local");
    expect(transport.sent.length).toBe(before + 1);
    await responder.close();
  });

  it("says goodbye with a zero TTL when closed", async () => {
    const network = new Network();
    const transport = network.attach(["192.168.1.23", "192.168.1.23/24"]);
    const responder = await startMdns({
      transport,
      candidates: ["monize"],
      addresses: adapters(["192.168.1.23", "192.168.1.23/24"]),
      log: () => undefined,
      timing: FAST,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await responder.close();
    const last = transport.sent.at(-1) as Packet;
    expect(last.isResponse).toBe(true);
    expect(last.answers[0]?.ttl).toBe(0);
  });

  it("gives up when every candidate is taken", async () => {
    const network = new Network();
    const holder = await startMdns({
      transport: network.attach(["192.168.1.23", "192.168.1.23/24"]),
      candidates: ["monize"],
      addresses: adapters(["192.168.1.23", "192.168.1.23/24"]),
      log: () => undefined,
      timing: FAST,
    });
    await expect(
      startMdns({
        transport: network.attach(["192.168.1.24", "192.168.1.24/24"]),
        candidates: ["monize"],
        addresses: adapters(["192.168.1.24", "192.168.1.24/24"]),
        log: () => undefined,
        timing: FAST,
      }),
    ).rejects.toBeInstanceOf(MdnsError);
    await holder.close();
  });
});

describe("addressFacing", () => {
  const list = adapters(
    ["192.168.1.23", "192.168.1.23/24"],
    ["172.29.80.1", "172.29.80.1/20"],
  )();

  it("picks the adapter on the asker's subnet", () => {
    expect(addressFacing("192.168.1.200", list)).toBe("192.168.1.23");
    expect(addressFacing("172.29.95.1", list)).toBe("172.29.80.1");
    expect(addressFacing("10.0.0.1", list)).toBeNull();
    expect(addressFacing("fe80::1", list)).toBeNull();
  });
});

describe("over a real UDP socket", () => {
  it("answers a legacy unicast query with its id and question", async () => {
    const transport = await udpTransport({ port: 0 });
    const responder = await startMdns({
      transport,
      candidates: ["monize"],
      addresses: adapters(["127.0.0.1", "127.0.0.1/8"]),
      log: () => undefined,
      timing: FAST,
    });
    const client = createSocket("udp4");
    await new Promise<void>((resolve) => client.bind(0, "127.0.0.1", resolve));
    const reply = new Promise<Packet>((resolve) =>
      client.once("message", (packet) => resolve(decodePacket(packet))),
    );
    client.send(
      encodePacket({
        id: 4242,
        isResponse: false,
        questions: [
          { name: "MONIZE.local", type: TYPE.A, unicastResponse: false },
        ],
      }),
      transport.port,
      "127.0.0.1",
    );
    const packet = await reply;
    expect(packet.id).toBe(4242);
    expect(packet.questions[0]?.name).toBe("monize.local");
    expect(packet.answers.map(aAddress)).toEqual(["127.0.0.1"]);
    client.close();
    await responder.close();
  });
});

describe("the claim's conflict rules", () => {
  it("treats its own announcement as no conflict", async () => {
    // A network that echoes everything back to the sender, as a socket with
    // multicast loopback on would.
    const echoes: Handler[] = [];
    const transport: MdnsTransport = {
      send: async (packet) =>
        echoes.forEach((h) =>
          h(packet, { address: "192.168.1.23", port: MDNS_PORT }),
        ),
      onMessage: (handler) => echoes.push(handler),
      join: () => undefined,
      close: async () => undefined,
    };
    const responder = await startMdns({
      transport,
      candidates: ["monize"],
      addresses: adapters(["192.168.1.23", "192.168.1.23/24"]),
      log: () => undefined,
      timing: FAST,
    });
    expect(responder.label).toBe("monize");
    await responder.close();
  });

  it("encodes the probe's proposed record in the authority section", () => {
    const probe = decodePacket(
      encodePacket({
        isResponse: false,
        questions: [
          { name: "monize.local", type: TYPE.ANY, unicastResponse: true },
        ],
        authorities: [aRecord("monize.local", "192.168.1.23", 120)],
      }),
    );
    expect(probe.questions[0]?.unicastResponse).toBe(true);
    expect(aAddress(probe.authorities[0] as never)).toBe("192.168.1.23");
  });
});
