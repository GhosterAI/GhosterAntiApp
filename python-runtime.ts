/**
 * The Python runtime of Python scripts. The desktop app does not bundle it. When the user
 * has or adds a Python script, or runs one, the app downloads CPython and the Playwright
 * wheels from their official sources, each pinned by size and SHA-256, and installs them
 * in <app data>/runtimes/python-<version>. That folder survives app updates. JavaScript
 * scripts run on the bundled Node and never need it.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { renameWhenUnlocked } from "./browser-install.ts";
import { sha256File } from "./browser-install.ts";
import { downloadResumable, type ResumableDownloadDeps } from "./runtime-download.ts";
import { extractZipTo } from "./unzip.ts";

export const PYTHON_VERSION = "3.13.7";
export const PYTHON_PLAYWRIGHT_VERSION = "1.58.0";
export const PYTHON_RUNTIME_VERSION = `${PYTHON_VERSION}-playwright-${PYTHON_PLAYWRIGHT_VERSION}`;

export const PYTHON_RUNTIME_FAILED = "The Python runtime for Python scripts could not be downloaded. Check your internet connection, then run the script again.";

export interface PinnedFile { url: string; size: number; sha256: string }

export interface PythonRuntimePins {
  /** CPython: python.org's Windows embeddable zip, or a python-build-standalone archive whose root is python/. */
  archive: PinnedFile;
  /** Playwright and its dependencies, unpacked into site-packages. */
  wheels: PinnedFile[];
}

const PYPI = "https://files.pythonhosted.org/packages";
const STANDALONE = "https://github.com/astral-sh/python-build-standalone/releases/download/20250918";
const PURE_WHEELS: PinnedFile[] = [
  {
    url: `${PYPI}/9b/4d/b9add7c84060d4c1906abe9a7e5359f2a60f7a9a4f67268b2766673427d8/pyee-13.0.0-py3-none-any.whl`,
    size: 15730, sha256: "48195a3cddb3b1515ce0695ed76036b5ccc2ef3a9f963ff9f77aec0139845498",
  },
  {
    url: `${PYPI}/18/67/36e9267722cc04a6b9f15c7f3441c2363321a3ea07da7ae0c0707beb2a9c/typing_extensions-4.15.0-py3-none-any.whl`,
    size: 44614, sha256: "f0fa19c6845758ab08074a0cfa8b7aecb71c999ca73d62883bc25cc018c4e548",
  },
];

/** The CPython and Playwright builds the desktop bundles carried before, per system. */
export const PYTHON_RUNTIME_PINS: Partial<Record<NodeJS.Platform, PythonRuntimePins>> = {
  win32: {
    archive: {
      url: `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
      size: 10922561, sha256: "f6cca216a359be84797cabb54149ce5e062afb16cc7567eb7fc51cacb2d86b65",
    },
    wheels: [
      {
        url: `${PYPI}/41/f8/5ec599c5e59d2f2f336a05b4f318e733077cd5044f24adb6f86900c3e6a7/playwright-1.58.0-py3-none-win_amd64.whl`,
        size: 36816005, sha256: "a2bf639d0ce33b3ba38de777e08697b0d8f3dc07ab6802e4ac53fb65e3907af8",
      },
      {
        url: `${PYPI}/1f/1b/54336d876186920e185066d8c3024ad55f21d7cc3683c856127ddb7b13ce/greenlet-3.1.1-cp313-cp313-win_amd64.whl`,
        size: 299490, sha256: "b42703b1cf69f2aa1df7d1030b9d77d3e584a70755674d60e710f0af570f3761",
      },
      ...PURE_WHEELS,
    ],
  },
  darwin: {
    archive: {
      url: `${STANDALONE}/cpython-${PYTHON_VERSION}%2B20250918-aarch64-apple-darwin-install_only_stripped.tar.gz`,
      size: 16544693, sha256: "10f26ea5fc7c4d9c012faf372898a801f34b8fd7730c677576263224d56835fe",
    },
    wheels: [
      {
        url: `${PYPI}/e0/40/59d34a756e02f8c670f0fee987d46f7ee53d05447d43cd114ca015cb168c/playwright-1.58.0-py3-none-macosx_11_0_arm64.whl`,
        size: 41039625, sha256: "70c763694739d28df71ed578b9c8202bb83e8fe8fb9268c04dd13afe36301f71",
      },
      {
        url: `${PYPI}/f3/57/0db4940cd7bb461365ca8d6fd53e68254c9dbbcc2b452e69d0d41f10a85e/greenlet-3.1.1-cp313-cp313-macosx_11_0_universal2.whl`,
        size: 272990, sha256: "05175c27cb459dcfc05d026c4232f9de8913ed006d42713cb8a5137bd49375f1",
      },
      ...PURE_WHEELS,
    ],
  },
  linux: {
    archive: {
      url: `${STANDALONE}/cpython-${PYTHON_VERSION}%2B20250918-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
      size: 33602096, sha256: "888fb7e192caafdb33e028f865b7da68dce5e924cfe58fcef96323e175a70e3e",
    },
    wheels: [
      {
        url: `${PYPI}/f1/af/009958cbf23fac551a940d34e3206e6c7eed2b8c940d0c3afd1feb0b0589/playwright-1.58.0-py3-none-manylinux1_x86_64.whl`,
        size: 46235268, sha256: "c95568ba1eda83812598c1dc9be60b4406dffd60b149bc1536180ad108723d6b",
      },
      {
        url: `${PYPI}/d9/42/b87bc2a81e3a62c3de2b0d550bf91a86939442b7ff85abb94eec3fc0e6aa/greenlet-3.1.1-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`,
        size: 660347, sha256: "efc0f674aa41b92da8c49e0346318c6075d734994c3c4e4430b1c3f853e498e4",
      },
      ...PURE_WHEELS,
    ],
  },
};

/** Holds the pins' fingerprint; written inside the runtime folder before its atomic rename. */
const STAMP = "ghosteranti-runtime.sha256";

export type PythonRuntimeState = "missing" | "downloading" | "ready" | "failed";

export interface PythonRuntimeStatus {
  state: PythonRuntimeState;
  version: string;
  receivedBytes: number;
  totalBytes: number;
  error?: string;
}

export interface PythonRuntimeOptions extends ResumableDownloadDeps {
  platform?: NodeJS.Platform;
  pins?: PythonRuntimePins;
  /** Unpacks the CPython archive into a folder and returns the runtime folder in it. */
  unpack?: (archive: string, directory: string) => Promise<string>;
  /** Runs the installed interpreter once before the runtime is accepted. */
  check?: (executable: string) => Promise<void>;
  log?: (message: string) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0) throw new Error(`${command[0]} exited with code ${child.exitCode}`);
}

async function unpackPython(archive: string, directory: string, platform: NodeJS.Platform): Promise<string> {
  const python = join(directory, "python");
  if (platform === "win32") {
    await extractZipTo(readFileSync(archive), python);
    // The embeddable build reads its import paths from this file only.
    const pth = join(python, "python313._pth");
    writeFileSync(pth, `${readFileSync(pth, "utf8").trimEnd()}\nLib/site-packages\n`, "utf8");
  } else {
    await run(["tar", "-xzf", archive, "-C", directory]);
  }
  return python;
}

/** The interpreter inside a runtime folder: the embeddable layout on Windows, the Unix layout elsewhere. */
function interpreter(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["python.exe"] : ["bin", "python3.13"];
}

async function checkPython(executable: string): Promise<void> {
  const child = Bun.spawn([executable, "-I", "-B", "-c", "import greenlet, playwright.async_api"], {
    stdout: "ignore", stderr: "pipe", windowsHide: true,
  });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`the Python runtime did not start: ${stderr.trim().split("\n").pop() || `exit ${code}`}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Installs the pinned Python runtime once and reports its download progress. */
export class PythonRuntime {
  readonly directory: string;
  readonly executable: string;
  readonly totalBytes: number;
  private readonly platform: NodeJS.Platform;
  private readonly pins: PythonRuntimePins;
  private readonly fingerprint: string;
  private readonly listeners = new Set<(status: PythonRuntimeStatus) => void>();
  private pending?: Promise<string>;
  private received = 0;
  private error?: string;
  /** A background download failed in this app run; a script run or the user still retries it. */
  private prefetchFailed = false;

  constructor(readonly root: string, private readonly options: PythonRuntimeOptions = {}) {
    this.platform = options.platform ?? process.platform;
    const pins = options.pins ?? PYTHON_RUNTIME_PINS[this.platform];
    if (!pins) throw new Error("Python scripts require Windows x64, Apple Silicon macOS or Linux x64");
    this.pins = pins;
    this.directory = join(root, `python-${PYTHON_RUNTIME_VERSION}`);
    this.executable = join(this.directory, ...interpreter(this.platform));
    const files = [pins.archive, ...pins.wheels];
    this.totalBytes = files.reduce((total, file) => total + file.size, 0);
    this.fingerprint = createHash("sha256").update([PYTHON_RUNTIME_VERSION, ...files.map((file) => file.sha256)].join("\n")).digest("hex");
  }

  installed(): boolean {
    try {
      return readFileSync(join(this.directory, STAMP), "utf8") === this.fingerprint;
    } catch {
      return false;
    }
  }

  status(): PythonRuntimeStatus {
    const base = { version: PYTHON_RUNTIME_VERSION, totalBytes: this.totalBytes };
    if (this.pending) return { ...base, state: "downloading", receivedBytes: this.received };
    if (this.installed()) return { ...base, state: "ready", receivedBytes: this.totalBytes };
    return this.error
      ? { ...base, state: "failed", receivedBytes: 0, error: this.error }
      : { ...base, state: "missing", receivedBytes: 0 };
  }

  /** Calls `listener` with each progress step of a download; returns its removal. */
  onProgress(listener: (status: PythonRuntimeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Install the runtime once at a time and return its interpreter. */
  ensure(): Promise<string> {
    if (this.installed()) return Promise.resolve(this.executable);
    if (!this.pending) {
      this.error = undefined;
      this.received = 0;
      this.pending = this.install().then((executable) => {
        this.prefetchFailed = false;
        return executable;
      }, (error) => {
        this.error = message(error);
        this.options.log?.(`Python runtime install failed: ${this.error}`);
        throw error;
      }).finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  /** Start the download in the background, unless it is installed, running or failed in this app run. */
  prefetch(): void {
    if (this.pending || this.prefetchFailed || this.installed()) return;
    this.ensure().catch(() => { this.prefetchFailed = true; });
  }

  /** Remove runtimes that are no longer pinned and the parts of interrupted installs. */
  prune(): void {
    let entries: string[];
    try { entries = readdirSync(this.root); } catch { return; }
    const name = basename(this.directory);
    for (const entry of entries) {
      if (!/^(\.tmp-|\.)?python-/.test(entry) || entry === name || entry === `.${name}.parts`) continue;
      // An install running now owns its temporary folder.
      if (this.pending && entry.startsWith(`.tmp-${name}-`)) continue;
      try { rmSync(join(this.root, entry), { recursive: true, force: true }); } catch {}
    }
  }

  private progress(received: number): void {
    this.received = received;
    const status: PythonRuntimeStatus = { state: "downloading", version: PYTHON_RUNTIME_VERSION, receivedBytes: received, totalBytes: this.totalBytes };
    for (const listener of this.listeners) listener(status);
  }

  private async install(): Promise<string> {
    const name = basename(this.directory);
    // The same names across attempts and app runs, so a broken download resumes.
    const parts = join(this.root, `.${name}.parts`);
    mkdirSync(parts, { recursive: true });
    const files: string[] = [];
    let done = 0;
    for (const pin of [this.pins.archive, ...this.pins.wheels]) {
      const partial = join(parts, `${pin.sha256.slice(0, 16)}.part`);
      await downloadResumable(pin.url, partial, pin.size, this.options, (bytes) => this.progress(done + bytes));
      if (await sha256File(partial) !== pin.sha256) {
        rmSync(partial, { force: true });
        throw new Error(`${decodeURIComponent(basename(new URL(pin.url).pathname))} did not match its pinned SHA-256`);
      }
      done += pin.size;
      files.push(partial);
    }
    const temp = join(this.root, `.tmp-${name}-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(temp, { recursive: true });
      const python = await (this.options.unpack ?? ((archive, directory) => unpackPython(archive, directory, this.platform)))(files[0]!, temp);
      const sitePackages = this.platform === "win32"
        ? join(python, "Lib", "site-packages")
        : join(python, "lib", "python3.13", "site-packages");
      mkdirSync(sitePackages, { recursive: true });
      for (const wheel of files.slice(1)) await extractZipTo(readFileSync(wheel), sitePackages);
      const executable = join(python, ...interpreter(this.platform));
      const driver = join(sitePackages, "playwright", "driver", this.platform === "win32" ? "node.exe" : "node");
      for (const required of [executable, driver]) {
        if (!statSync(required, { throwIfNoEntry: false })?.isFile()) throw new Error("the Python runtime is incomplete");
      }
      // Unpacked wheels keep no file modes; the Playwright driver must be executable.
      if (this.platform !== "win32") chmodSync(driver, 0o755);
      await (this.options.check ?? checkPython)(executable);
      writeFileSync(join(python, STAMP), this.fingerprint);
      // A folder left by an interrupted earlier install has no valid stamp.
      rmSync(this.directory, { recursive: true, force: true });
      await renameWhenUnlocked(python, this.directory);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    rmSync(parts, { recursive: true, force: true });
    return this.executable;
  }
}
