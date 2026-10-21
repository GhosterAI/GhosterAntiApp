import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore, legacyHubUrl, parseAppConfig } from "./app-config.ts";

describe("GhosterAnti app config", () => {
  test("fresh installs default to Local mode with Local analytics disabled", () => {
    const root = mkdtempSync(join(tmpdir(), "ghosteranti-config-"));
    expect(new AppConfigStore(join(root, "config.json")).read()).toEqual({
      version: 1,
      mode: "local",
      localAnalytics: false,
    });
  });

  test("config parsing always enforces local mode", () => {
    expect(parseAppConfig({ version: 1, mode: "cloud", cloudUrl: "http://example.com", localAnalytics: false })).toEqual({
      version: 1,
      mode: "local",
      localAnalytics: false,
    });
  });

  test("writes normalized config atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "ghosteranti-config-"));
    const path = join(root, "config.json");
    const store = new AppConfigStore(path);
    expect(store.setMode("local")).toEqual({
      version: 1,
      mode: "local",
      localAnalytics: false,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(store.read());
  });

  test("switching mode always maintains Local mode", () => {
    const root = mkdtempSync(join(tmpdir(), "ghosteranti-config-"));
    const store = new AppConfigStore(join(root, "config.json"));
    expect(store.setMode("local")).toEqual({ version: 1, mode: "local", localAnalytics: false });
  });

  test("legacy HUB_URL is disabled in local mode", () => {
    const env = { HUB_URL: "https://legacy-hub.example" };
    expect(legacyHubUrl({ version: 1, mode: "local", localAnalytics: false }, env)).toBeUndefined();
  });
});
