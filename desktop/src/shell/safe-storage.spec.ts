import { effectiveSafeStorage } from "./safe-storage";

function storage(backend?: string) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (data: Buffer) => data.toString().replace(/^enc:/, ""),
    ...(backend === undefined
      ? {}
      : { getSelectedStorageBackend: () => backend }),
  };
}

describe("effectiveSafeStorage", () => {
  it("treats Linux basic_text as no encryption", () => {
    expect(
      effectiveSafeStorage(
        storage("basic_text"),
        "linux",
      ).isEncryptionAvailable(),
    ).toBe(false);
  });

  it("passes a real keyring and Windows through", () => {
    expect(
      effectiveSafeStorage(
        storage("gnome_libsecret"),
        "linux",
      ).isEncryptionAvailable(),
    ).toBe(true);
    const windows = effectiveSafeStorage(storage(), "win32");
    expect(windows.isEncryptionAvailable()).toBe(true);
    expect(windows.decryptString(windows.encryptString("s"))).toBe("s");
  });
});
