import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PYTHON_RUNTIME_PINS, PYTHON_RUNTIME_VERSION, PythonRuntime, type PinnedFile, type PythonRuntimeOptions } from "./python-runtime.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function runtimesRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-python-runtime-"));
  roots.push(root);
  return join(root, "runtimes");
}

const encode = (value: string) => new TextEncoder().encode(value);

/** A ZIP of stored (uncompressed) files. */
function storedZip(files: Record<string, string>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = encode(path);
    const contents = encode(text);
    const local = new Uint8Array(30 + name.length + contents.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, contents.length, true);
    lv.setUint32(22, contents.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(contents, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, contents.length, true);
    cv.setUint32(24, contents.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

const pin = (url: string, bytes: Uint8Array): PinnedFile => ({ url, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

const ARCHIVE = storedZip({ "python.exe": "python", "python313._pth": "python313.zip\n.\n", "python313.zip": "stdlib" });
const PLAYWRIGHT = storedZip({ "playwright/__init__.py": "", "playwright/driver/node.exe": "driver" });
const GREENLET = storedZip({ "greenlet/__init__.py": "" });
const FILES: Record<string, Uint8Array> = {
  "https://python.test/python.zip": ARCHIVE,
  "https://pypi.test/playwright.whl": PLAYWRIGHT,
  "https://pypi.test/greenlet.whl": GREENLET,
};
const PINS = {
  archive: pin("https://python.test/python.zip", ARCHIVE),
  wheels: [pin("https://pypi.test/playwright.whl", PLAYWRIGHT), pin("https://pypi.test/greenlet.whl", GREENLET)],
};
const TOTAL = ARCHIVE.length + PLAYWRIGHT.length + GREENLET.length;

type Fault = "error" | "http503" | "cut" | undefined;

/** A file server that answers Range requests, with faults chosen per request. */
function serve(files: Record<string, Uint8Array> = FILES, options: { fault?: (url: string, request: number) => Fault; ignoreRange?: boolean } = {}) {
  const requests: Array<{ url: string; range?: string }> = [];
  const fetch = async (url: string, init: RequestInit) => {
    const range = new Headers(init.headers).get("range") ?? undefined;
    requests.push({ url, range });
    const fault = options.fault?.(url, requests.filter((request) => request.url === url).length);
    if (fault === "error") throw new Error("network is down");
    if (fault === "http503") return new Response("busy", { status: 503 });
    const bytes = files[url];
    if (!bytes) return new Response("missing", { status: 404 });
    const start = range && !options.ignoreRange ? Number(/^bytes=(\d+)-$/.exec(range)![1]) : 0;
    const body = bytes.subarray(start);
    const headers = start > 0 ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : undefined;
    if (fault === "cut") {
      const half = body.subarray(0, Math.floor(body.length / 2));
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error("connection reset"));
          else controller.enqueue(half);
          sent = true;
        },
      });
      return new Response(stream, { status: start > 0 ? 206 : 200, headers });
    }
    return new Response(new Uint8Array(body), { status: start > 0 ? 206 : 200, headers });
  };
  return { requests, fetch };
}

function runtime(root: string, options: PythonRuntimeOptions = {}): PythonRuntime {
  return new PythonRuntime(root, {
    platform: "win32", pins: PINS, sleep: async () => {}, attempts: 3, check: async () => {}, ...options,
  });
}

function leftovers(root: string): string[] {
  return readdirSync(root).filter((entry) => entry.startsWith(".tmp-"));
}

test("every desktop system has pinned CPython and Playwright files", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const pins = PYTHON_RUNTIME_PINS[platform]!;
    expect(pins.wheels.length).toBe(4);
    for (const file of [pins.archive, ...pins.wheels]) {
      expect(file.url).toStartWith("https://");
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.size).toBeGreaterThan(0);
    }
    expect(pins.wheels.some((wheel) => wheel.url.includes("/playwright-1.58.0-"))).toBe(true);
  }
});

test("installs the pinned runtime atomically in its version folder and reports progress", async () => {
  const root = runtimesRoot();
  const server = serve();
  const checked: string[] = [];
  const python = runtime(root, { fetch: server.fetch, check: async (executable) => { checked.push(executable); } });
  const progress: number[] = [];
  python.onProgress((status) => progress.push(status.receivedBytes));
  expect(python.status()).toMatchObject({ state: "missing", totalBytes: TOTAL });

  const executable = await python.ensure();

  expect(executable).toBe(join(root, `python-${PYTHON_RUNTIME_VERSION}`, "python.exe"));
  expect(readFileSync(executable, "utf8")).toBe("python");
  const site = join(python.directory, "Lib", "site-packages");
  expect(readFileSync(join(site, "playwright", "driver", "node.exe"), "utf8")).toBe("driver");
  expect(existsSync(join(site, "greenlet", "__init__.py"))).toBe(true);
  expect(readFileSync(join(python.directory, "python313._pth"), "utf8")).toEndWith("\nLib/site-packages\n");
  // The interpreter ran before the folder got its final name.
  expect(checked).toHaveLength(1);
  expect(checked[0]).not.toStartWith(python.directory);
  expect(python.installed()).toBe(true);
  expect(python.status()).toMatchObject({ state: "ready", receivedBytes: TOTAL });
  expect(progress.at(-1)).toBe(TOTAL);
  expect(progress).toEqual([...progress].sort((a, b) => a - b));
  expect(readdirSync(root)).toEqual([`python-${PYTHON_RUNTIME_VERSION}`]);

  // An installed runtime needs no download, also from a new app run.
  await runtime(root, { fetch: server.fetch }).ensure();
  expect(server.requests).toHaveLength(3);
});

test("a download failure fails clearly and installs nothing", async () => {
  const root = runtimesRoot();
  const server = serve(FILES, { fault: () => "error" });
  const python = runtime(root, { fetch: server.fetch });
  await expect(python.ensure()).rejects.toThrow("network is down");
  expect(server.requests).toHaveLength(3);
  expect(python.status()).toMatchObject({ state: "failed", error: "network is down" });
  expect(existsSync(python.directory)).toBe(false);
  expect(leftovers(root)).toEqual([]);
});

test("HTTP errors are retried and an unavailable file reports its status", async () => {
  const root = runtimesRoot();
  const flaky = serve(FILES, { fault: (_url, request) => request === 1 ? "http503" : undefined });
  await runtime(root, { fetch: flaky.fetch }).ensure();
  expect(flaky.requests).toHaveLength(6);

  const missing = serve({});
  await expect(runtime(runtimesRoot(), { fetch: missing.fetch }).ensure()).rejects.toThrow("HTTP 404");
});

test("a SHA-256 mismatch discards that file and installs nothing", async () => {
  const root = runtimesRoot();
  const changed = new Uint8Array(PLAYWRIGHT);
  changed[changed.length - 1]! ^= 1;
  const server = serve({ ...FILES, "https://pypi.test/playwright.whl": changed });
  const python = runtime(root, { fetch: server.fetch });
  await expect(python.ensure()).rejects.toThrow("playwright.whl did not match its pinned SHA-256");
  expect(existsSync(python.directory)).toBe(false);
  const parts = readdirSync(join(root, `.python-${PYTHON_RUNTIME_VERSION}.parts`));
  // The verified archive stays for the next attempt; the changed wheel does not.
  expect(parts).toEqual([`${PINS.archive.sha256.slice(0, 16)}.part`]);

  const fixed = serve();
  await runtime(root, { fetch: fixed.fetch }).ensure();
  expect(fixed.requests.map((request) => request.url)).toEqual(["https://pypi.test/playwright.whl", "https://pypi.test/greenlet.whl"]);
});

test("a broken download resumes with a Range request", async () => {
  const root = runtimesRoot();
  const server = serve(FILES, { fault: (url, request) => url.endsWith("playwright.whl") && request === 1 ? "cut" : undefined });
  await runtime(root, { fetch: server.fetch }).ensure();
  const playwright = server.requests.filter((request) => request.url.endsWith("playwright.whl"));
  expect(playwright).toEqual([
    { url: "https://pypi.test/playwright.whl", range: undefined },
    { url: "https://pypi.test/playwright.whl", range: `bytes=${Math.floor(PLAYWRIGHT.length / 2)}-` },
  ]);
});

test("a download saved by an earlier app run resumes, and a server that ignores Range starts over", async () => {
  for (const ignoreRange of [false, true]) {
    const root = runtimesRoot();
    const parts = join(root, `.python-${PYTHON_RUNTIME_VERSION}.parts`);
    mkdirSync(parts, { recursive: true });
    writeFileSync(join(parts, `${PINS.archive.sha256.slice(0, 16)}.part`), ARCHIVE.subarray(0, 40));
    const server = serve(FILES, { ignoreRange });
    await runtime(root, { fetch: server.fetch }).ensure();
    expect(server.requests[0]).toEqual({ url: "https://python.test/python.zip", range: "bytes=40-" });
    expect(readdirSync(root)).toEqual([`python-${PYTHON_RUNTIME_VERSION}`]);
  }
});

test("a failed install check leaves no runtime and keeps the downloads for the next try", async () => {
  const root = runtimesRoot();
  const server = serve();
  const python = runtime(root, { fetch: server.fetch, check: async () => { throw new Error("the Python runtime did not start: missing DLL"); } });
  await expect(python.ensure()).rejects.toThrow("missing DLL");
  expect(existsSync(python.directory)).toBe(false);
  expect(leftovers(root)).toEqual([]);

  await runtime(root, { fetch: server.fetch }).ensure();
  expect(server.requests).toHaveLength(3);
});

test("a runtime folder without the stamp of these pins is replaced", async () => {
  const root = runtimesRoot();
  const directory = join(root, `python-${PYTHON_RUNTIME_VERSION}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "python.exe"), "interrupted");
  writeFileSync(join(directory, "ghosteranti-runtime.sha256"), "other pins");
  const python = runtime(root, { fetch: serve().fetch });
  expect(python.installed()).toBe(false);
  await python.ensure();
  expect(readFileSync(python.executable, "utf8")).toBe("python");
});

test("concurrent requests share one install", async () => {
  const root = runtimesRoot();
  const server = serve();
  const python = runtime(root, { fetch: server.fetch });
  const results = await Promise.all([python.ensure(), python.ensure(), python.ensure()]);
  expect(new Set(results).size).toBe(1);
  expect(server.requests).toHaveLength(3);
});

test("prefetch downloads in the background once and leaves a failure to the next run or the user", async () => {
  const root = runtimesRoot();
  let down = true;
  const server = serve(FILES, { fault: () => down ? "error" : undefined });
  const logs: string[] = [];
  const python = runtime(root, { fetch: server.fetch, attempts: 1, log: (line) => logs.push(line) });
  python.prefetch();
  python.prefetch();
  expect(python.status().state).toBe("downloading");
  await Bun.sleep(10);
  expect(server.requests).toHaveLength(1);
  expect(python.status().state).toBe("failed");
  expect(logs).toEqual(["Python runtime install failed: network is down"]);
  python.prefetch();
  await Bun.sleep(10);
  expect(server.requests).toHaveLength(1);

  down = false;
  await python.ensure();
  expect(python.status().state).toBe("ready");
  python.prefetch();
  expect(server.requests).toHaveLength(4);
});

test("prune removes unpinned runtimes and interrupted installs and keeps other runtimes", () => {
  const root = runtimesRoot();
  const current = `python-${PYTHON_RUNTIME_VERSION}`;
  const entries = [current, `.${current}.parts`, "python-3.12.0-playwright-1.50.0", ".python-3.12.0-playwright-1.50.0.parts",
    `.tmp-${current}-1-2`, "chromium-155.0.8059.31", "firefox-fonts", "cloakbrowser-146"];
  for (const entry of entries) mkdirSync(join(root, entry), { recursive: true });
  runtime(root).prune();
  expect(readdirSync(root).sort()).toEqual([`.${current}.parts`, current, "chromium-155.0.8059.31", "cloakbrowser-146", "firefox-fonts"].sort());
});

test("the Unix layout gets an executable Playwright driver", async () => {
  const root = runtimesRoot();
  const playwright = storedZip({ "playwright/driver/node": "driver" });
  const archive = encode("tar archive");
  const files = { "https://python.test/python.tar.gz": archive, "https://pypi.test/playwright.whl": playwright };
  const python = new PythonRuntime(root, {
    platform: "linux", fetch: serve(files).fetch, sleep: async () => {}, check: async () => {},
    pins: { archive: pin("https://python.test/python.tar.gz", archive), wheels: [pin("https://pypi.test/playwright.whl", playwright)] },
    unpack: async (file, directory) => {
      expect(readFileSync(file, "utf8")).toBe("tar archive");
      const unpacked = join(directory, "python");
      mkdirSync(join(unpacked, "bin"), { recursive: true });
      writeFileSync(join(unpacked, "bin", "python3.13"), "python");
      return unpacked;
    },
  });
  expect(await python.ensure()).toBe(join(root, `python-${PYTHON_RUNTIME_VERSION}`, "bin", "python3.13"));
  const driver = join(python.directory, "lib", "python3.13", "site-packages", "playwright", "driver", "node");
  expect(readFileSync(driver, "utf8")).toBe("driver");
  if (process.platform !== "win32") expect(statSync(driver).mode & 0o111).toBe(0o111);
});
