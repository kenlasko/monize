import { createSocket, Socket } from "dgram";

import { Endpoint, MDNS_GROUP, MDNS_PORT, MdnsTransport } from "./mdns";

/**
 * The real network under the mDNS responder: one IPv4 UDP socket on port
 * 5353, shared with any other responder on the PC (Windows' own, in the DNS
 * Client service) through SO_REUSEADDR. Whether Windows lets the two share
 * the port is the question task N0 of the plan answers on a real machine.
 *
 * Sends go out one at a time, because the adapter a multicast leaves from is
 * a socket option set just before each one.
 */

export interface UdpTransportOptions {
  /** 5353; a spec passes 0 for a free port. */
  readonly port?: number;
  readonly group?: string;
  readonly createSocket?: () => Socket;
}

export async function udpTransport(
  options: UdpTransportOptions = {},
): Promise<MdnsTransport & { readonly port: number }> {
  const group = options.group ?? MDNS_GROUP;
  const socket =
    options.createSocket?.() ?? createSocket({ type: "udp4", reuseAddr: true });
  const joined = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let closed = false;

  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind({ port: options.port ?? MDNS_PORT, exclusive: false }, () => {
      socket.off("error", reject);
      resolve();
    });
  });
  socket.on("error", () => undefined);
  socket.setMulticastTTL(255);
  // Our own announcements must not read back as another device's answer.
  socket.setMulticastLoopback(false);

  return {
    port: socket.address().port,
    send(packet, to: Endpoint, via) {
      const next = queue.then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (closed) {
              resolve();
              return;
            }
            if (via !== null) socket.setMulticastInterface(via);
            socket.send(packet, to.port, to.address, (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      );
      queue = next.catch(() => undefined);
      return next;
    },
    onMessage(handler) {
      socket.on("message", (packet, from) =>
        handler(packet, { address: from.address, port: from.port }),
      );
    },
    join(addresses) {
      for (const address of addresses) {
        if (joined.has(address)) continue;
        try {
          socket.addMembership(group, address);
          joined.add(address);
        } catch {
          // An adapter that went away, or one that cannot multicast.
        }
      }
    },
    async close() {
      if (closed) return;
      await queue;
      closed = true;
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    },
  };
}
