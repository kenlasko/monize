import { NetworkInterfaceInfo } from "os";

import {
  addressUrls,
  allowedHosts,
  InterfaceTable,
  isAllowedPeer,
  servedAddresses,
  servedNames,
} from "./addresses";

function v4(
  address: string,
  cidr: string,
  internal = false,
): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr,
  };
}

function v6(address: string, cidr: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr,
    scopeid: 0,
  };
}

/** A home PC: a WSL adapter listed first, then Wi-Fi on a dual-stack network. */
const TABLE: InterfaceTable = {
  "vEthernet (WSL)": [v4("172.29.80.1", "172.29.80.1/20")],
  "Wi-Fi": [
    v4("192.168.1.23", "192.168.1.23/24"),
    v6("2001:db8:5:6::23", "2001:db8:5:6::23/64"),
    v6("fd12:3456::23", "fd12:3456::23/64"),
    v6("fe80::1234", "fe80::1234/64"),
  ],
  "Loopback Pseudo-Interface 1": [v4("127.0.0.1", "127.0.0.1/8", true)],
};

describe("servedAddresses", () => {
  it("offers private and unique-local addresses only, the home network's first", () => {
    expect(servedAddresses(TABLE).map((entry) => entry.address)).toEqual([
      "192.168.1.23",
      "fd12:3456::23",
      "172.29.80.1",
    ]);
  });
});

describe("isAllowedPeer", () => {
  it.each([
    "192.168.1.50",
    "::ffff:192.168.1.50",
    "10.1.2.3",
    "fd12:3456::99",
    "fe80::99",
    "169.254.10.10",
    "127.0.0.1",
    // The home network's own global IPv6 prefix: a phone on the Wi-Fi.
    "2001:db8:5:6::99",
  ])("accepts %s", (address) => {
    expect(isAllowedPeer(address, TABLE)).toBe(true);
  });

  it.each(["8.8.8.8", "203.0.113.9", "2001:db8:ffff::1", "100.64.0.5", "junk"])(
    "refuses %s",
    (address) => {
      expect(isAllowedPeer(address, TABLE)).toBe(false);
    },
  );
});

describe("servedNames and the addresses built from them", () => {
  const names = servedNames({
    mdnsLabel: "monize",
    computerLabel: "desktop-1",
    addresses: servedAddresses(TABLE),
  });

  it("names the mDNS name first, then the computer, then each address", () => {
    expect(names).toEqual({
      dns: ["monize.local", "desktop-1.local"],
      ip: ["192.168.1.23", "fd12:3456::23", "172.29.80.1"],
    });
  });

  it("leaves out a name that is unknown", () => {
    expect(
      servedNames({ mdnsLabel: null, computerLabel: null, addresses: [] }),
    ).toEqual({ dns: [], ip: [] });
  });

  it("accepts each as a Host with the port, IPv6 in brackets", () => {
    expect([...allowedHosts(names, 3382)]).toEqual([
      "monize.local:3382",
      "desktop-1.local:3382",
      "192.168.1.23:3382",
      "[fd12:3456::23]:3382",
      "172.29.80.1:3382",
    ]);
  });

  it("lists the https addresses best first", () => {
    expect(addressUrls(names, 3382)[0]).toBe("https://monize.local:3382");
  });
});
