import { test, expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ghosterantiChromiumArchive,
  ghosterantiChromiumExecutable,
  CLOAKBROWSER_LINUX_EXECUTABLE_SHA256,
  CLOAKBROWSER_MACOS_EXECUTABLE_SHA256,
  cloakBrowserExecutableSha256,
  defaultChromiumRuntime,
  ensureGhosterAntiChromium,
  ensureCloakBrowser,
  hostChromiumRuntime,
  hostDisplayScale,
  LINUX_CHROMIUM_APPARMOR_PROFILE,
  linuxChromiumSandboxBlocked,
  pruneBrowserRuntimes,
  supportsChromium155Host,
  type GhosterAntiChromiumDeps,
} from "./ghosteranti-chromium.ts";

const WINDOWS_155 = ghosterantiChromiumArchive("win32");
import { buildNewProfile } from "./create.ts";
import { parseExport, serializeAdsTxt, serializeXlsxRows } from "./parse.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { ProfileStore } from "./store.ts";

/** Fake archive whose files carry their pinned hashes by content. */
function fakeRelease(options: { archiveHash?: string; executableHash?: string } = {}) {
  const downloads: string[] = [];
  const deps: GhosterAntiChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, options.archiveHash ?? WINDOWS_155.archiveSha256);
    },
    extract: async (_archive, directory) => {
      const root = join(directory, "aliasmode-chromium-155.0.8059.85-windows-x64");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "chrome.exe"), options.executableHash ?? WINDOWS_155.executableSha256);
      writeFileSync(join(root, "chrome.dll"), "dll");
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  return { deps, downloads };
}

test("installs GhosterAnti's own 155 build once, beside any earlier runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  mkdirSync(join(root, ".chromium-155.0.8059.85-aliasmode.2-stale"));
  // Earlier runtimes stay put for browsers still running from them.
  const earlier = ["chromium-155.0.8059.31", "chromium-155.0.8059.31-aliasmode.1", "chromium-155.0.8059.31-aliasmode.2", "chromium-155.0.8059.85-aliasmode.1"];
  for (const dir of earlier) mkdirSync(join(root, dir));
  const release = fakeRelease();

  const executable = await ensureGhosterAntiChromium(root, release.deps, "win32");
  expect(executable).toBe(ghosterantiChromiumExecutable(root, "win32"));
  expect(release.downloads).toEqual([WINDOWS_155.url]);
  expect(WINDOWS_155.url).toBe(
    "https://github.com/aliasmode/aliasmode-chromium/releases/download/v155.0.8059.85-aliasmode.2/aliasmode-chromium-155.0.8059.85-windows-x64.zip",
  );
  expect([WINDOWS_155.archiveSha256, WINDOWS_155.executableSha256]).toEqual([
    "f52c6db95f039f7c93996e0a0f22687f8260f6fa88a9738eec2557be29e841c3",
    "c49a5ef03306e4e786d5561143e800ff30b461f3b4298a2817eb364042a79fa2",
  ]);
  expect(executable).toBe(join(root, "chromium-155.0.8059.85-aliasmode.2", "chrome.exe"));
  expect(readdirSync(root).sort()).toEqual([...earlier, "chromium-155.0.8059.85-aliasmode.2"]);

  expect(await ensureGhosterAntiChromium(root, release.deps, "win32")).toBe(executable);
  expect(release.downloads).toHaveLength(1);
});

test("Linux x64 installs upstream's 155 build from its zstd tar archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  const linux = ghosterantiChromiumArchive("linux");
  const downloads: string[] = [];
  const deps: GhosterAntiChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, linux.archiveSha256);
    },
    extract: async (_archive, directory) => {
      const runtime = join(directory, "apostate-155.0.8059.31-linux-x64");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, "chrome"), linux.executableSha256);
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  expect(supportsChromium155Host("linux", "x64")).toBe(true);
  expect(supportsChromium155Host("linux", "arm64")).toBe(false);
  const executable = await ensureGhosterAntiChromium(root, deps, "linux");
  expect(executable).toBe(join(root, "chromium-155.0.8059.31", "chrome"));
  expect(executable).toBe(ghosterantiChromiumExecutable(root, "linux"));
  expect(downloads).toEqual(["https://github.com/heretic-tech/apostate/releases/download/v0.5.1/apostate-155.0.8059.31-linux-x64.tar.zst"]);
  expect(readdirSync(root)).toEqual(["chromium-155.0.8059.31"]);
});

test("Windows pins its own 155.0.8059.85 build while macOS and Linux keep upstream's 155.0.8059.31", () => {
  expect(ghosterantiChromiumExecutable("/runtimes", "win32")).toBe(join("/runtimes", "chromium-155.0.8059.85-aliasmode.2", "chrome.exe"));
  expect(ghosterantiChromiumExecutable("/runtimes", "darwin"))
    .toBe(join("/runtimes", "chromium-155.0.8059.31", "Chromium.app/Contents/MacOS/Chromium"));
  expect(ghosterantiChromiumExecutable("/runtimes", "linux")).toBe(join("/runtimes", "chromium-155.0.8059.31", "chrome"));
  expect(ghosterantiChromiumArchive("darwin").url)
    .toBe("https://github.com/heretic-tech/apostate/releases/download/v0.5.1/apostate-155.0.8059.31-macos-arm64.zip");
});

test("rejects an archive or executable that does not match its pin", async () => {
  for (const options of [{ archiveHash: "0".repeat(64) }, { executableHash: "1".repeat(64) }]) {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
    await expect(ensureGhosterAntiChromium(root, fakeRelease(options).deps, "win32")).rejects.toThrow("Chromium 155");
    expect(existsSync(ghosterantiChromiumExecutable(root, "win32"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  }
});

test("new profiles keep their Chromium runtime fixed locally and in Cloud payloads", () => {
  const store = new ProfileStore(":memory:");
  const beta = buildNewProfile({ chromiumRuntime: "ghosteranti" }, () => false);
  const standard = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  expect(standard.chromiumRuntime).toBeUndefined();
  expect(() => buildNewProfile({ engine: "firefox", chromiumRuntime: "ghosteranti" }, () => false)).toThrow();
  expect(() => buildNewProfile({ chromiumRuntime: "chrome-200" }, () => false)).toThrow("unsupported Chromium runtime");

  store.upsertProfile(beta);
  store.upsertProfile(standard);
  const { chromiumRuntime: _runtime, ...edited } = store.getProfile(beta.id)!;
  store.upsertProfile({ ...edited, name: "renamed" });
  expect(store.getProfile(beta.id)).toMatchObject({ name: "renamed", chromiumRuntime: "ghosteranti" });
  const { hardware: _stored, ...standardEdit } = store.getProfile(standard.id)!;
  expect(() => store.upsertProfile({ ...standardEdit, chromiumRuntime: "ghosteranti" }))
    .toThrow("Chromium runtime cannot change in place");
  expect(store.getProfile(standard.id)!.chromiumRuntime).toBeUndefined();

  // Cloud carries the runtime in schema V3, which older clients reject
  // instead of opening it on CloakBrowser. Default profiles stay V1.
  const payload = encodePortableProfile(beta);
  expect(payload.schemaVersion).toBe(3);
  expect(payload.profile).toMatchObject({ chromiumRuntime: "ghosteranti" });
  expect(decodePortableProfile(payload).profile.chromiumRuntime).toBe("ghosteranti");
  // A profile without stored hardware (made before it existed) stays V1.
  const { hardware: _hardware, ...legacy } = standard;
  const standardPayload = encodePortableProfile(legacy);
  expect(standardPayload.schemaVersion).toBe(1);
  expect("chromiumRuntime" in standardPayload.profile).toBe(false);
  expect(decodePortableProfile(standardPayload).profile.chromiumRuntime).toBeUndefined();
  expect(() => decodePortableProfile({ ...standardPayload, profile: { ...standardPayload.profile, chromiumRuntime: "ghosteranti" } } as any))
    .toThrow("unsupported portable profile payload");
  expect(() => decodePortableProfile({ ...standardPayload, schemaVersion: 3 } as any)).toThrow("unsupported portable profile payload");
  store.close();
});

test("exports name the Chrome version of every Chromium profile so a re-import keeps it", () => {
  const beta = buildNewProfile({ chromiumRuntime: "ghosteranti" }, () => false);
  const standard = buildNewProfile({ chromiumRuntime: "cloakbrowser" }, () => false);
  const firefox = buildNewProfile({ engine: "firefox" }, () => false);
  const text = serializeAdsTxt([beta, standard, firefox]);
  expect(text.match(/^chromium_runtime=ghosteranti$/gm)).toHaveLength(1);
  expect(text.match(/^chromium_runtime=cloakbrowser$/gm)).toHaveLength(1);
  expect(text.match(/^chromium_runtime=/gm)).toHaveLength(2);
  const imported = parseExport(text).profiles;
  expect(imported.find((profile) => profile.id === beta.id)?.chromiumRuntime).toBe("ghosteranti");
  expect(imported.find((profile) => profile.id === standard.id)?.chromiumRuntime).toBeUndefined();
  expect(serializeXlsxRows([standard]).headers).toContain("chromium_runtime");
  expect(serializeXlsxRows([firefox]).headers).not.toContain("chromium_runtime");
});

test("macOS uses the 155 runtime for Chromium profiles unless a CloakBrowser binary is configured", () => {
  expect(hostChromiumRuntime("darwin", {})).toBe("ghosteranti");
  expect(hostChromiumRuntime("darwin", { CLOAKBROWSER_BINARY_PATH: "/opt/cloakbrowser" })).toBeUndefined();
  expect(hostChromiumRuntime("win32", {})).toBeUndefined();
  expect(hostChromiumRuntime("linux", {})).toBeUndefined();
});

test("new Chromium profiles use Chromium 155 wherever the computer can run it", () => {
  expect(defaultChromiumRuntime("win32", "x64", {})).toBe("ghosteranti");
  expect(defaultChromiumRuntime("linux", "x64", {})).toBe("ghosteranti");
  expect(defaultChromiumRuntime("darwin", "arm64", {})).toBe("ghosteranti");
  expect(defaultChromiumRuntime("darwin", "arm64", { CLOAKBROWSER_BINARY_PATH: "/opt/cloakbrowser" })).toBeUndefined();
  expect(defaultChromiumRuntime("win32", "arm64", {})).toBeUndefined();
  expect(defaultChromiumRuntime("linux", "arm64", {})).toBeUndefined();
});

test("the host display scale comes from the desktop app, and 1 stands in for a missing or invalid value", () => {
  expect(hostDisplayScale({ GHOSTERANTI_HOST_SCALE: "1.25" })).toBe(1.25);
  expect(hostDisplayScale({ GHOSTERANTI_HOST_SCALE: "2" })).toBe(2);
  for (const value of [undefined, "", "abc", "0", "0.5", "-1.5", "Infinity"]) {
    expect(hostDisplayScale({ GHOSTERANTI_HOST_SCALE: value })).toBe(1);
  }
});

test("installs the pinned CloakBrowser build for macOS from its tar archive root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-cloakbrowser-"));
  const downloads: string[] = [];
  const deps: GhosterAntiChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, "505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c");
    },
    extract: async (_archive, directory) => {
      const bundle = join(directory, "Chromium.app", "Contents", "MacOS");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "Chromium"), CLOAKBROWSER_MACOS_EXECUTABLE_SHA256);
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  const executable = await ensureCloakBrowser(root, "darwin", "arm64", deps);
  expect(executable).toBe(join(root, "cloakbrowser-145.0.7632.109.2", "Chromium.app", "Contents", "MacOS", "Chromium"));
  expect(downloads).toEqual([
    "https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v145.0.7632.109.2/cloakbrowser-darwin-arm64.tar.gz",
  ]);
  expect(await ensureCloakBrowser(root, "darwin", "arm64", deps)).toBe(executable);
  expect(downloads).toHaveLength(1);
  expect(readdirSync(root)).toEqual(["cloakbrowser-145.0.7632.109.2"]);
});

test("installs the pinned CloakBrowser build for Linux from its tar archive root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-cloakbrowser-"));
  const downloads: string[] = [];
  const deps: GhosterAntiChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e");
    },
    extract: async (_archive, directory) => writeFileSync(join(directory, "chrome"), CLOAKBROWSER_LINUX_EXECUTABLE_SHA256),
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  const executable = await ensureCloakBrowser(root, "linux", "x64", deps);
  expect(executable).toBe(join(root, "cloakbrowser-146.0.7680.177.5", "chrome"));
  expect(downloads).toEqual([
    "https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-linux-x64.tar.gz",
  ]);
  expect(await ensureCloakBrowser(root, "linux", "x64", deps)).toBe(executable);
  expect(downloads).toHaveLength(1);
});

const WINDOWS_CLOAKBROWSER_ARCHIVE = "b213795cb32c3169f766c74ce1d0275fc89d3df256de39c04da7fb4c23b7fdbe";
const WINDOWS_CLOAKBROWSER_EXECUTABLE = "03f53661a5c47e7b0a661bee2bce8a0d302b7a60834c328df417561fa0636d80";

test("installs the CloakBrowser build that the Windows app bundled before, from its zip archive root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-cloakbrowser-"));
  const downloads: string[] = [];
  const deps: GhosterAntiChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, WINDOWS_CLOAKBROWSER_ARCHIVE);
    },
    extract: async (_archive, directory) => {
      writeFileSync(join(directory, "chrome.exe"), WINDOWS_CLOAKBROWSER_EXECUTABLE);
      writeFileSync(join(directory, "chrome.dll"), "dll");
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  // The same executable keeps the launch identity of every existing Windows profile.
  expect(cloakBrowserExecutableSha256("win32", "x64")).toBe(WINDOWS_CLOAKBROWSER_EXECUTABLE);
  expect(cloakBrowserExecutableSha256("win32", "arm64")).toBeUndefined();
  const executable = await ensureCloakBrowser(root, "win32", "x64", deps);
  expect(executable).toBe(join(root, "cloakbrowser-146.0.7680.177.5", "chrome.exe"));
  expect(downloads).toEqual([
    "https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
  ]);
  expect(readdirSync(join(root, "cloakbrowser-146.0.7680.177.5")).sort()).toEqual(["chrome.dll", "chrome.exe"]);
  expect(readdirSync(root)).toEqual(["cloakbrowser-146.0.7680.177.5"]);
  await expect(ensureCloakBrowser(root, "win32", "arm64", deps)).rejects.toThrow("CloakBrowser does not run");
});

/** A Windows CloakBrowser release whose download breaks `breaks` times, each after `step` bytes. */
function brokenDownload(breaks: number, step: number) {
  const outputs: string[] = [];
  const offsets: number[] = [];
  const sleeps: number[] = [];
  const deps: GhosterAntiChromiumDeps = {
    download: async (_url, output) => {
      outputs.push(output);
      const have = existsSync(output) ? statSync(output).size : 0;
      offsets.push(have);
      const rest = WINDOWS_CLOAKBROWSER_ARCHIVE.slice(have);
      if (offsets.length > breaks) {
        appendFileSync(output, rest);
        return;
      }
      appendFileSync(output, rest.slice(0, step));
      throw new Error("connection reset");
    },
    extract: async (_archive, directory) => writeFileSync(join(directory, "chrome.exe"), WINDOWS_CLOAKBROWSER_EXECUTABLE),
    hashFile: async (path) => readFileSync(path, "utf8"),
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { deps, outputs, offsets, sleeps };
}

test("a broken download continues from the saved part, and attempts that add bytes do not use up the retries", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-cloakbrowser-"));
  const release = brokenDownload(7, 4);
  await ensureCloakBrowser(root, "win32", "x64", release.deps);
  expect(release.offsets).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
  // One partial file, outside the temporary install folders.
  expect(new Set(release.outputs)).toEqual(new Set([join(root, ".cloakbrowser-146.0.7680.177.5.b213795cb32c3169.part")]));
  expect(release.sleeps).toHaveLength(7);
  expect(readdirSync(root)).toEqual(["cloakbrowser-146.0.7680.177.5"]);
});

test("a download that adds nothing stops after five attempts and keeps its part for the next try", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-cloakbrowser-"));
  const failing = brokenDownload(Infinity, 0);
  await expect(ensureCloakBrowser(root, "win32", "x64", failing.deps)).rejects.toThrow("connection reset");
  expect(failing.offsets).toEqual([0, 0, 0, 0, 0]);
  expect(failing.sleeps).toEqual([2000, 4000, 8000, 16000]);
  expect(existsSync(join(root, "cloakbrowser-146.0.7680.177.5"))).toBe(false);

  // A part saved by an earlier app run survives the cleanup of temporary folders and continues.
  const partial = join(root, ".cloakbrowser-146.0.7680.177.5.b213795cb32c3169.part");
  writeFileSync(partial, WINDOWS_CLOAKBROWSER_ARCHIVE.slice(0, 10));
  mkdirSync(join(root, ".cloakbrowser-146.0.7680.177.5-123-456"));
  const resumed = brokenDownload(0, 0);
  await ensureCloakBrowser(root, "win32", "x64", resumed.deps);
  expect(resumed.offsets).toEqual([10]);
  expect(readdirSync(root)).toEqual(["cloakbrowser-146.0.7680.177.5"]);
});

test("a completed download that does not match its pin is deleted, so the next try starts over", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-cloakbrowser-"));
  const partial = join(root, ".cloakbrowser-146.0.7680.177.5.b213795cb32c3169.part");
  writeFileSync(partial, "corrupted bytes from an earlier run");
  const release = brokenDownload(0, 0);
  await expect(ensureCloakBrowser(root, "win32", "x64", release.deps)).rejects.toThrow("CloakBrowser archive did not match its pinned SHA-256");
  expect(readdirSync(root)).toEqual([]);
  await ensureCloakBrowser(root, "win32", "x64", release.deps);
  expect(release.offsets).toEqual([35, 0]);
});

test("removes runtimes and parts that are no longer pinned, but not one a live browser runs from", () => {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-runtimes-"));
  const pinned155 = basename(dirname(ghosterantiChromiumExecutable(root, "win32")));
  const kept = [
    "cloakbrowser-146.0.7680.177.5",
    ".cloakbrowser-146.0.7680.177.5.b213795cb32c3169.part",
    ".cloakbrowser-146.0.7680.177.5-99-1",
    pinned155,
    // A live browser still runs from this one.
    "chromium-155.0.8059.31",
    // Other runtimes under the same root are not this module's.
    "firefox-fonts",
    "python-3.13.7",
  ];
  const removed = [
    "cloakbrowser-145.0.7632.109.2",
    "chromium-155.0.8059.31-aliasmode.1",
    ".chromium-155.0.8059.31-aliasmode.1.7892833b6126b133.part",
    ".chromium-155.0.8059.31-aliasmode.1-12-34",
  ];
  for (const entry of [...kept, ...removed]) mkdirSync(join(root, entry));
  const live = join(root, "chromium-155.0.8059.31", "chrome.exe");
  pruneBrowserRuntimes(root, [live, "D:\\elsewhere\\chrome.exe"], "win32", "x64");
  expect(readdirSync(root).sort()).toEqual(kept.sort());
  pruneBrowserRuntimes(join(root, "missing"), [], "win32", "x64");
});

test("Linux blocks the Chrome sandbox only when AppArmor restricts user namespaces and our profile is missing", () => {
  const sysctl = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  const read = (value: string) => (path: string) => {
    if (path !== sysctl) throw new Error(`unexpected read ${path}`);
    return value;
  };
  const missing = () => { throw new Error("no such file"); };
  expect(linuxChromiumSandboxBlocked(read("1\n"), () => false)).toBe(true);
  expect(linuxChromiumSandboxBlocked(read("1\n"), (path) => path === LINUX_CHROMIUM_APPARMOR_PROFILE)).toBe(false);
  expect(linuxChromiumSandboxBlocked(read("0\n"), () => false)).toBe(false);
  expect(linuxChromiumSandboxBlocked(missing, () => false)).toBe(false);
});
