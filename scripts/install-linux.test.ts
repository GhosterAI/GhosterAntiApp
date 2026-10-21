import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LINUX_CHROMIUM_APPARMOR_PROFILE } from "../ghosteranti-chromium.ts";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

test("the Linux installer, build and release workflows agree on the release file names", () => {
  const installer = read("scripts/install-linux.sh");
  const build = read(".github/workflows/linux-desktop.yml");
  const release = read(".github/workflows/linux-release.yml");

  expect(installer).toContain('archive="GhosterAnti_${version}_x86_64-linux.tar.gz"');
  expect(installer).toContain('"$base/v$version/SHA256SUMS-linux.txt"');
  expect(build).toContain("GhosterAnti_${version}_x86_64-linux.tar.gz");
  expect(build).toContain("SHA256SUMS-linux.txt");
  expect(release).toContain("GhosterAnti_${VERSION}_x86_64-linux.tar.gz");
  expect(release).toContain("SHA256SUMS-linux.txt");
  // The app reads this feed and archive name (src-tauri/src/releases.rs).
  const updater = read("src-tauri/src/releases.rs");
  expect(updater).toContain('const UPDATE_MANIFEST: &str = "latest-linux.json";');
  expect(updater).toContain('format!("GhosterAnti_{version}_x86_64-linux.tar.gz")');
  expect(release).toContain("assets/latest-linux.json");
  expect(release).toContain('{version: $version, platforms: {"linux-x86_64": {url: $url, signature: $signature}}}');
  // The Windows update feed accepts exactly one platform, so Linux files must never enter it.
  expect(release).not.toContain("latest-v2.json");
  expect(release).not.toContain("--clobber");
});

test("the Linux installer writes the AppArmor profile that the app looks for, for the folders the app uses", () => {
  const installer = read("scripts/install-linux.sh");
  expect(installer).toContain(`apparmor_profile="${LINUX_CHROMIUM_APPARMOR_PROFILE}"`);
  // Chromium 155 and CloakBrowser runtimes both live in <data>/runtimes/<dir>/chrome.
  expect(installer).toContain("@{HOME}/.local/share/com.ghosteranti.desktop/runtimes/*/chrome");
  // The app folder and its data folder follow the XDG data home that agent/runtime-client.mjs reads.
  expect(installer).toContain('root="$data_home/ghosteranti"');
  expect(read("agent/runtime-client.mjs")).toContain('join(linuxDataHome(env), "ghosteranti", "bin", "ghosteranti")');
});
