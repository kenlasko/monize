import {
  LOGIN_DEVICE_MAX_AGE_MS,
  issueLoginDeviceCookie,
  loginDeviceCookieName,
  verifyLoginDeviceCookie,
} from "./login-device";

describe("login-device cookie", () => {
  const key = "k".repeat(64);
  const hash = "$2a$12$somebcrypthash";
  const now = Date.UTC(2026, 10, 14);

  it("verifies for the account and password it was minted under", () => {
    const cookie = issueLoginDeviceCookie(key, "user-1", hash, now);
    expect(verifyLoginDeviceCookie(key, "user-1", hash, cookie, now)).toBe(
      true,
    );
  });

  it("refuses another account, key or password, and a tampered mac", () => {
    const cookie = issueLoginDeviceCookie(key, "user-1", hash, now);
    const [iat, nonce, mac] = cookie.split(".");
    const flipped = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
    expect(verifyLoginDeviceCookie(key, "user-2", hash, cookie, now)).toBe(
      false,
    );
    expect(
      verifyLoginDeviceCookie("x".repeat(64), "user-1", hash, cookie, now),
    ).toBe(false);
    // A replaced password revokes every cookie issued under the old one.
    expect(
      verifyLoginDeviceCookie(key, "user-1", `${hash}x`, cookie, now),
    ).toBe(false);
    expect(
      verifyLoginDeviceCookie(
        key,
        "user-1",
        hash,
        `${iat}.${nonce}.${flipped}`,
        now,
      ),
    ).toBe(false);
  });

  it("expires on the server, and refuses an issue time in the future", () => {
    const cookie = issueLoginDeviceCookie(key, "user-1", hash, now);
    expect(
      verifyLoginDeviceCookie(
        key,
        "user-1",
        hash,
        cookie,
        now + LOGIN_DEVICE_MAX_AGE_MS,
      ),
    ).toBe(true);
    expect(
      verifyLoginDeviceCookie(
        key,
        "user-1",
        hash,
        cookie,
        now + LOGIN_DEVICE_MAX_AGE_MS + 1000,
      ),
    ).toBe(false);
    const future = issueLoginDeviceCookie(key, "user-1", hash, now + 3_600_000);
    expect(verifyLoginDeviceCookie(key, "user-1", hash, future, now)).toBe(
      false,
    );
  });

  it("refuses malformed values", () => {
    const cookie = issueLoginDeviceCookie(key, "user-1", hash, now);
    for (const bad of [undefined, 42, "", "..", "a.b", `${cookie}.x`]) {
      expect(verifyLoginDeviceCookie(key, "user-1", hash, bad, now)).toBe(
        false,
      );
    }
  });

  it("names one cookie per account, stable and opaque", () => {
    const name = loginDeviceCookieName(key, "user-1");
    expect(name).toBe(loginDeviceCookieName(key, "user-1"));
    expect(name).not.toBe(loginDeviceCookieName(key, "user-2"));
    expect(name).not.toContain("user-1");
    expect(name).toMatch(/^login_device_[A-Za-z0-9_-]{22}$/);
  });

  it("mints a fresh nonce each time", () => {
    expect(issueLoginDeviceCookie(key, "user-1", hash, now)).not.toBe(
      issueLoginDeviceCookie(key, "user-1", hash, now),
    );
  });
});
