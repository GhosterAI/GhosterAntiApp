/**
 * Browser runtimes that are downloaded on first use instead of being bundled:
 * the opt-in Chromium 155 beta, and CloakBrowser. Each is pinned by archive and
 * executable SHA-256, and lives in the app's data folder, which survives app updates.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  CLOAKBROWSER_MACOS_VERSION, CLOAKBROWSER_VERSION, CLOAKBROWSER_WINDOWS_X64_ARCHIVE_SHA256,
  CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256, renameWhenUnlocked, sha256File,
} from "./browser-install.ts";

// GhosterAnti's own Windows build of the patch series. Its package includes Chromium's
// version manifest, which upstream's Windows archive omits. Each build gets its
// own directory, so a browser still running from an earlier build keeps its files.
// A new build changes the version, the release tag and the two SHA-256 values of its release.
const WINDOWS_VERSION = "155.0.8059.85";
const WINDOWS_RELEASE = "aliasmode.2";
const WINDOWS_BUILD = {
  root: `aliasmode-chromium-${WINDOWS_VERSION}-windows-x64`,
  url: `https://github.com/aliasmode/aliasmode-chromium/releases/download/v${WINDOWS_VERSION}-${WINDOWS_RELEASE}/aliasmode-chromium-${WINDOWS_VERSION}-windows-x64.zip`,
  dir: `chromium-${WINDOWS_VERSION}-${WINDOWS_RELEASE}`,
  archiveSha256: "f52c6db95f039f7c93996e0a0f22687f8260f6fa88a9738eec2557be29e841c3",
  executable: "chrome.exe",
  executableSha256: "c49a5ef03306e4e786d5561143e800ff30b461f3b4298a2817eb364042a79fa2",
  // Pages read and draw at --force-device-scale-factor, and
  // --ghosteranti-window-label names the window without touching page titles.
  hostScale: true,
  windowLabel: true,
  // Behind an HTTP proxy, where WebRTC has no UDP, --fingerprint-webrtc-ip still gives a page
  // an mDNS host candidate and a server-reflexive candidate at that address, and sends nothing.
  webRtcIp: true,
};
// Upstream's Apostate v0.5.1 keeps its own Chromium version.
const APOSTATE_VERSION = "155.0.8059.31";
const APOSTATE_RELEASE = "https://github.com/heretic-tech/apostate/releases/download/v0.5.1";
const MACOS_BUILD = {
  root: `apostate-${APOSTATE_VERSION}-macos-arm64`,
  url: `${APOSTATE_RELEASE}/apostate-${APOSTATE_VERSION}-macos-arm64.zip`,
  dir: `chromium-${APOSTATE_VERSION}`,
  archiveSha256: "58176ba9b3e9cfd74029165bdf716c636e618af17a48bd905fe6d5f1552d901a",
  executable: "Chromium.app/Contents/MacOS/Chromium",
  executableSha256: "2dfa8b148e6d06598981c4a1e1bc0d7c2c7860d74401ad0d934d21a10c7916d7",
  hostScale: false,
  windowLabel: false,
  webRtcIp: false,
};
const LINUX_BUILD = {
  root: `apostate-${APOSTATE_VERSION}-linux-x64`,
  url: `${APOSTATE_RELEASE}/apostate-${APOSTATE_VERSION}-linux-x64.tar.zst`,
  dir: `chromium-${APOSTATE_VERSION}`,
  archiveSha256: "351955271b7ba1aed314bf14c2d64f6bd59bfdcb5c4a1541c9c921c570ff97bb",
  executable: "chrome",
  executableSha256: "c0b906dc621cec05330aed9d3b09bbb7b655a9c8546e4c61d222705fabfde6d3",
  hostScale: false,
  windowLabel: false,
  webRtcIp: false,
};
// Apple Silicon macOS and Linux get upstream's builds; every other host keeps the Windows pins.
function chromiumBuild(platform: NodeJS.Platform): typeof WINDOWS_BUILD {
  return platform === "darwin" ? MACOS_BUILD : platform === "linux" ? LINUX_BUILD : WINDOWS_BUILD;
}
const BUILD = chromiumBuild(process.platform);
export const GHOSTERANTI_CHROMIUM_ARCHIVE_URL = BUILD.url;
export const GHOSTERANTI_CHROMIUM_ARCHIVE_SHA256 = BUILD.archiveSha256;
export const GHOSTERANTI_CHROMIUM_EXECUTABLE_SHA256 = BUILD.executableSha256;
/** The pinned Windows build can draw pages at the display's own scale; an earlier build must get scale 1. */
export const GHOSTERANTI_CHROMIUM_HOST_SCALE = WINDOWS_BUILD.hostScale;
/** The pinned Windows build takes --ghosteranti-window-label. */
export const GHOSTERANTI_CHROMIUM_WINDOW_LABEL = WINDOWS_BUILD.windowLabel;
/** The pinned Windows build shows --fingerprint-webrtc-ip behind an HTTP proxy, where WebRTC has no UDP. */
export const GHOSTERANTI_CHROMIUM_WEBRTC_IP = WINDOWS_BUILD.webRtcIp;

/** One downloadable, hash-pinned browser runtime under the runtimes root. */
interface PinnedRuntime {
  label: string;
  dir: string;
  url: string;
  archiveSha256: string;
  /** Directory inside the archive that holds the runtime; empty when the archive root is the runtime. */
  archiveRoot: string;
  executable: string;
  executableSha256: string;
}

function chromium155(platform: NodeJS.Platform): PinnedRuntime {
  const build = chromiumBuild(platform);
  return {
    label: "Chromium 155",
    dir: build.dir,
    url: build.url,
    archiveSha256: build.archiveSha256,
    archiveRoot: build.root,
    executable: build.executable,
    executableSha256: build.executableSha256,
  };
}

// CloakBrowser publishes no macOS build after 145, so that build opens CloakBrowser profiles on a Mac.
export const CLOAKBROWSER_MACOS_EXECUTABLE_SHA256 = "79ddf7e7a7be8087319390ed79266387f6499b8a2e45ccfbaa724d7e7fff6b79";
const CLOAKBROWSER_MACOS: PinnedRuntime = {
  label: "CloakBrowser",
  dir: `cloakbrowser-${CLOAKBROWSER_MACOS_VERSION}`,
  url: `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_MACOS_VERSION}/cloakbrowser-darwin-arm64.tar.gz`,
  archiveSha256: "505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c",
  archiveRoot: "",
  executable: "Chromium.app/Contents/MacOS/Chromium",
  executableSha256: CLOAKBROWSER_MACOS_EXECUTABLE_SHA256,
};

// The Linux app downloads CloakBrowser's own Linux build on first use.
export const CLOAKBROWSER_LINUX_EXECUTABLE_SHA256 = "715722e8605ae3ce81523c1218aba1ec89425786ab33ceaf99f8a6cb5e70e6e8";
const CLOAKBROWSER_LINUX: PinnedRuntime = {
  label: "CloakBrowser",
  dir: `cloakbrowser-${CLOAKBROWSER_VERSION}`,
  url: `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_VERSION}/cloakbrowser-linux-x64.tar.gz`,
  archiveSha256: "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e",
  archiveRoot: "",
  executable: "chrome",
  executableSha256: CLOAKBROWSER_LINUX_EXECUTABLE_SHA256,
};

// The Windows app downloads the build it bundled before, so profiles keep their exact kernel.
const CLOAKBROWSER_WINDOWS: PinnedRuntime = {
  label: "CloakBrowser",
  dir: `cloakbrowser-${CLOAKBROWSER_VERSION}`,
  url: `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_VERSION}/cloakbrowser-windows-x64.zip`,
  archiveSha256: CLOAKBROWSER_WINDOWS_X64_ARCHIVE_SHA256,
  archiveRoot: "",
  executable: "chrome.exe",
  executableSha256: CLOAKBROWSER_WINDOWS_X64_EXECUTABLE_SHA256,
};

/** The CloakBrowser build that the app downloads on this computer; none where CloakBrowser does not run. */
function cloakBrowser(platform: NodeJS.Platform, arch: string): PinnedRuntime | undefined {
  if (platform === "darwin" && arch === "arm64") return CLOAKBROWSER_MACOS;
  if (platform === "linux" && arch === "x64") return CLOAKBROWSER_LINUX;
  if (platform === "win32" && arch === "x64") return CLOAKBROWSER_WINDOWS;
  return undefined;
}

/** SHA-256 of the CloakBrowser executable that the app downloads on this computer. */
export function cloakBrowserExecutableSha256(platform: NodeJS.Platform, arch: string): string | undefined {
  return cloakBrowser(platform, arch)?.executableSha256;
}

/** The computers that can run Chromium 155. */
export function supportsChromium155Host(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === "win32" && arch === "x64") || (platform === "darwin" && arch === "arm64")
    || (platform === "linux" && arch === "x64");
}

/** The AppArmor profile that the Linux install command adds for the downloaded Chrome runtimes. */
export const LINUX_CHROMIUM_APPARMOR_PROFILE = "/etc/apparmor.d/ghosteranti-chromium";

/**
 * Ubuntu 23.10 and later let a program create the user namespace of Chrome's sandbox only when
 * an AppArmor profile allows it. These Chrome builds have no setuid sandbox helper to fall back on.
 */
export function linuxChromiumSandboxBlocked(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  exists: (path: string) => boolean = existsSync,
): boolean {
  try {
    if (read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim() !== "1") return false;
  } catch {
    return false;
  }
  return !exists(LINUX_CHROMIUM_APPARMOR_PROFILE);
}

/** New Chromium profiles made on macOS use this runtime, unless a CloakBrowser binary is configured. */
export function hostChromiumRuntime(platform = process.platform, env = process.env): "ghosteranti" | undefined {
  return platform === "darwin" && !env.CLOAKBROWSER_BINARY_PATH ? "ghosteranti" : undefined;
}

/** New Chromium profiles that name no runtime use Chromium 155 wherever this computer can run it. */
export function defaultChromiumRuntime(platform = process.platform, arch: string = process.arch, env = process.env): "ghosteranti" | undefined {
  if (platform === "darwin") return hostChromiumRuntime(platform, env);
  return supportsChromium155Host(platform, arch) ? "ghosteranti" : undefined;
}

/**
 * The primary display's scale, which the desktop app passes in GHOSTERANTI_HOST_SCALE
 * (1.25 at 125%). 1 when it is missing or is not a display scale.
 */
export function hostDisplayScale(env: NodeJS.ProcessEnv = process.env): number {
  const scale = Number(env.GHOSTERANTI_HOST_SCALE);
  return Number.isFinite(scale) && scale >= 1 ? scale : 1;
}

/** The primary display's size in physical pixels, which the desktop app passes in GHOSTERANTI_HOST_SCREEN. */
export function hostDisplaySize(env: NodeJS.ProcessEnv = process.env): { width: number; height: number } | null {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(env.GHOSTERANTI_HOST_SCREEN ?? "");
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** Chromium 155 on Windows draws pages at the display's scale; every other launch at 1. */
export function chromiumDeviceScale(hostPlatform: NodeJS.Platform, chromiumRuntime: string | undefined, hostScale: number): number {
  return hostPlatform === "win32" && chromiumRuntime && GHOSTERANTI_CHROMIUM_HOST_SCALE ? hostScale : 1;
}

export interface GhosterAntiChromiumDeps {
  /** One download attempt. It continues the partial file that an earlier attempt or app run left. */
  download?: (url: string, output: string) => Promise<void>;
  extract?: (archive: string, directory: string) => Promise<void>;
  hashFile?: (path: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0) throw new Error(`${command[0]} exited with code ${child.exitCode}`);
}

/**
 * curl, not fetch: on Windows curl.exe trusts the Windows certificate store, so a company
 * proxy that inspects TLS works. A download that gets under 1 KB/s for a minute stops,
 * and the next attempt continues it.
 */
async function curlDownload(url: string, output: string, platform: NodeJS.Platform): Promise<void> {
  const child = Bun.spawn([
    platform === "win32" ? "curl.exe" : "curl", "--fail", "--location", "--silent", "--show-error",
    "--continue-at", "-", "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "60",
    "--output", output, url,
  ], { stdout: "ignore", stderr: "ignore" });
  const code = await child.exited;
  // 33: the server cannot continue the saved part, so the next attempt starts over.
  if (code === 33) rmSync(output, { force: true });
  if (code !== 0) throw new Error(`curl exited with code ${code}`);
}

const DOWNLOAD_ATTEMPTS = 5;

function fileSize(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

/** Retry a broken download. Only attempts that add no bytes count toward the limit. */
async function downloadWithRetry(
  url: string,
  partial: string,
  download: (url: string, output: string) => Promise<void>,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let failures = 0; ;) {
    const before = fileSize(partial);
    try {
      await download(url, partial);
      return;
    } catch (error) {
      if (fileSize(partial) <= before && ++failures >= DOWNLOAD_ATTEMPTS) throw error;
      await sleep(Math.min(30_000, 1000 * 2 ** failures));
    }
  }
}

export function ghosterantiChromiumExecutable(root: string, platform = process.platform): string {
  const build = chromiumBuild(platform);
  return join(root, build.dir, build.executable);
}

/** The pinned 155 archive of one system. */
export function ghosterantiChromiumArchive(platform: NodeJS.Platform): { url: string; archiveSha256: string; executableSha256: string } {
  const { url, archiveSha256, executableSha256 } = chromiumBuild(platform);
  return { url, archiveSha256, executableSha256 };
}

// ditto and tar keep the symlinks and code signature of a macOS app bundle.
function extractCommand(url: string, file: string, directory: string, platform: NodeJS.Platform): string[] {
  if (url.endsWith(".tar.gz")) return ["tar", "-xzf", file, "-C", directory];
  if (url.endsWith(".tar.zst")) return ["tar", "--zstd", "-xf", file, "-C", directory];
  return platform === "darwin" ? ["ditto", "-x", "-k", file, directory] : ["tar.exe", "-xf", file, "-C", directory];
}

/** The download in progress keeps this name across attempts and app runs, so it can continue. */
function partialName(spec: PinnedRuntime): string {
  return `.${spec.dir}.${spec.archiveSha256.slice(0, 16)}.part`;
}

async function install(spec: PinnedRuntime, root: string, deps: GhosterAntiChromiumDeps, platform: NodeJS.Platform): Promise<string> {
  const hashFile = deps.hashFile ?? sha256File;
  const target = join(root, spec.dir);
  const executable = join(target, spec.executable);
  if (existsSync(executable) && await hashFile(executable) === spec.executableSha256) {
    return executable;
  }

  mkdirSync(root, { recursive: true });
  const tempPrefix = `.${spec.dir}-`;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(tempPrefix)) rmSync(join(root, entry), { recursive: true, force: true });
  }
  const partial = join(root, partialName(spec));
  await downloadWithRetry(
    spec.url,
    partial,
    deps.download ?? ((url, output) => curlDownload(url, output, platform)),
    deps.sleep ?? Bun.sleep,
  );
  if (await hashFile(partial) !== spec.archiveSha256) {
    rmSync(partial, { force: true });
    throw new Error(`${spec.label} archive did not match its pinned SHA-256`);
  }
  const temp = join(root, `${tempPrefix}${process.pid}-${Date.now()}`);
  const archive = join(temp, "runtime.archive");
  const extracted = join(temp, "extracted");
  mkdirSync(extracted, { recursive: true });
  try {
    await renameWhenUnlocked(partial, archive);
    await (deps.extract ?? ((file, directory) => run(extractCommand(spec.url, file, directory, platform))))(archive, extracted);
    const runtime = spec.archiveRoot ? join(extracted, spec.archiveRoot) : extracted;
    if (await hashFile(join(runtime, spec.executable)) !== spec.executableSha256) {
      throw new Error(`${spec.label} archive contained an unexpected executable`);
    }
    rmSync(target, { recursive: true, force: true });
    await renameWhenUnlocked(runtime, target);
    return executable;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const installing = new Map<string, Promise<string>>();

/** Install a pinned runtime once at a time and return its executable. */
function ensure(spec: PinnedRuntime, root: string, deps: GhosterAntiChromiumDeps, platform: NodeJS.Platform): Promise<string> {
  const key = `${root}\0${spec.dir}`;
  let pending = installing.get(key);
  if (!pending) {
    pending = install(spec, root, deps, platform).finally(() => installing.delete(key));
    installing.set(key, pending);
  }
  return pending;
}

/** Install the pinned Chromium 155 runtime and return its executable. */
export function ensureGhosterAntiChromium(root: string, deps: GhosterAntiChromiumDeps = {}, platform = process.platform): Promise<string> {
  return ensure(chromium155(platform), root, deps, platform);
}

/** Install the pinned CloakBrowser build of this computer and return its executable. */
export function ensureCloakBrowser(root: string, platform = process.platform, arch: string = process.arch, deps: GhosterAntiChromiumDeps = {}): Promise<string> {
  const spec = cloakBrowser(platform, arch);
  if (!spec) return Promise.reject(new Error(`CloakBrowser does not run on ${platform} ${arch}`));
  return ensure(spec, root, deps, platform);
}

function within(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Remove downloaded Chromium and CloakBrowser runtimes that are no longer pinned, with their
 * partial downloads. A runtime that holds one of `inUse` (a live browser's executable) stays
 * until a later start. Other folders under the runtimes root are left alone.
 */
export function pruneBrowserRuntimes(root: string, inUse: readonly string[], platform = process.platform, arch: string = process.arch): void {
  let entries: string[];
  let real: string;
  try {
    entries = readdirSync(root);
    real = realpathSync(root);
  } catch {
    return;
  }
  const pins = [chromium155(platform), ...(cloakBrowser(platform, arch) ? [cloakBrowser(platform, arch)!] : [])];
  const keep = new Set(pins.flatMap((spec) => [spec.dir, partialName(spec)]));
  for (const entry of entries) {
    if (!/^\.?(chromium|cloakbrowser)-/.test(entry) || keep.has(entry)) continue;
    // An install running now owns its temporary folder; the next install removes stale ones.
    if (pins.some((spec) => entry.startsWith(`.${spec.dir}-`))) continue;
    const path = join(real, entry);
    if (inUse.some((executable) => within(path, executable))) continue;
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
}
