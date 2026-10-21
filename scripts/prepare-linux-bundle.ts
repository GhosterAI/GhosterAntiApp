/** Stages the Linux x64 bundle inputs: sidecar, GhosterAnti Firefox and the agent runtime. */
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIREFOX_RUNTIME_VERSION, firefoxBuildForHost, installFirefox } from "../firefox-install.ts";
import { installSourceNode } from "../source-runtime.ts";
import { GHOSTERANTI_VERSION } from "../version.ts";
import { compileSidecar, stageAgentRuntime } from "./prepare-windows-bundle.ts";

const BUN_TARGET = "bun-linux-x64-baseline";
const RUST_TARGET = "x86_64-unknown-linux-gnu";

export async function prepareLinuxBundle(cwd = process.cwd()): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Linux bundle preparation requires Linux x64");
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

  cpSync(await installSourceNode(staging), join(playwrightRoot, "node", "node"));
  stageAgentRuntime(cwd, playwrightRoot);

  const metadata = {
    firefox: {
      executable: build.executablePath,
      sha256: firefox.sha256,
      version: FIREFOX_RUNTIME_VERSION,
      archiveSha256: build.archiveSha256,
    },
  };
  writeFileSync(join(tauri, "generated", "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(tauri, "generated", "VERSION.txt"), `${GHOSTERANTI_VERSION}\n`, "utf8");
}

if (import.meta.main) {
  try {
    await prepareLinuxBundle();
    console.log("prepared GhosterAnti Linux bundle");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
