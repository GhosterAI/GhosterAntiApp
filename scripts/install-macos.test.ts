import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

test("the macOS installer, build and release workflows agree on the release file names", () => {
  const installer = read("scripts/install-macos.sh");
  const build = read(".github/workflows/macos-desktop.yml");
  const release = read(".github/workflows/macos-release.yml");

  expect(installer).toContain('archive="GhosterAnti_${version}_aarch64.app.tar.gz"');
  expect(installer).toContain('"$base/v$version/SHA256SUMS-macos.txt"');
  expect(build).toContain("GhosterAnti_${version}_aarch64.app.tar.gz");
  expect(build).toContain("SHA256SUMS-macos.txt");
  expect(release).toContain("GhosterAnti_${VERSION}_aarch64.app.tar.gz");
  expect(release).toContain("SHA256SUMS-macos.txt");
  // The app reads this feed and archive name (src-tauri/src/releases.rs).
  const updater = read("src-tauri/src/releases.rs");
  expect(updater).toContain('const UPDATE_MANIFEST: &str = "latest-macos.json";');
  expect(updater).toContain('format!("GhosterAnti_{version}_aarch64.app.tar.gz")');
  expect(release).toContain("assets/latest-macos.json");
  expect(release).toContain('{version: $version, platforms: {"darwin-aarch64": {url: $url, signature: $signature}}}');
  // The Windows update feed accepts exactly one platform, so macOS files must never enter it.
  expect(release).not.toContain("latest-v2.json");
  expect(release).not.toContain("--clobber");
});
