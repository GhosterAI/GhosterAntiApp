/** Stages the macOS arm64 bundle inputs: sidecar, GhosterAnti Firefox and the agent runtime. */
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256File } from "../browser-install.ts";
import { FIREFOX_RUNTIME_VERSION, firefoxBuildForHost, installFirefox } from "../firefox-install.ts";
import { installSourceNode } from "../source-runtime.ts";
import { GHOSTERANTI_VERSION } from "../version.ts";
import { compileSidecar, stageAgentRuntime } from "./prepare-windows-bundle.ts";

const BUN_TARGET = "bun-darwin-arm64";
const RUST_TARGET = "aarch64-apple-darwin";

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`${command[0]} exited with code ${child.exitCode}`);
}

export async function prepareMacosBundle(cwd = process.cwd()): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("macOS bundle preparation requires Apple Silicon macOS");
  }
  const tauri = join(resolve(cwd), "src-tauri");
  const staging = join(tauri, "target", "desktop-staging");
  const firefoxRoot = join(tauri, "resources", "firefox");
  const playwrightRoot = join(tauri, "resources", "playwright");
  for (const path of [staging, firefoxRoot, playwrightRoot]) rmSync(path, { recursive: true, force: true });
  for (const path of [staging, join(tauri, "generated"), join(tauri, "binaries"), join(playwrightRoot, "node")]) {
    mkdirSync(path, { recursive: true });
  }

  await compileSidecar(cwd, join(tauri, "binaries", `ghosteranti-sidecar-${RUST_TARGET}`), BUN_TARGET);

  const build = firefoxBuildForHost();
  const firefox = await installFirefox({ cwd: staging, writeEnv: false });
  renameSync(resolve(firefox.path, ...build.executablePath.split("/").map(() => "..")), firefoxRoot);
  // The published engine bundle has no resource seal, so macOS reports its signature as broken.
  // Seal it after the pinned hashes passed; the packaged hash below is the sealed executable.
  await run(["codesign", "--force", "--deep", "--sign", "-", join(firefoxRoot, "AliasMode.app")]);
  const firefoxSha256 = await sha256File(join(firefoxRoot, build.executablePath));

  cpSync(await installSourceNode(staging), join(playwrightRoot, "node", "node"));
  stageAgentRuntime(cwd, playwrightRoot);

  const metadata = {
    firefox: {
      executable: build.executablePath,
      sha256: firefoxSha256,
      version: FIREFOX_RUNTIME_VERSION,
      archiveSha256: build.archiveSha256,
    },
  };
  writeFileSync(join(tauri, "generated", "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(tauri, "generated", "VERSION.txt"), `${GHOSTERANTI_VERSION}\n`, "utf8");
}

if (import.meta.main) {
  try {
    await prepareMacosBundle();
    console.log("prepared GhosterAnti macOS bundle");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
