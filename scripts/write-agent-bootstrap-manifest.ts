import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { GHOSTERANTI_VERSION } from "../version.ts";

export function buildAgentBootstrapManifest(options: {
  installer: string;
  releaseBase: string;
}) {
  const installer = resolve(options.installer);
  const bytes = readFileSync(installer);
  const releaseBase = options.releaseBase.replace(/\/$/, "");
  if (!/^https:\/\/github\.com\/GhosterAI\/GhosterAnti\/releases\/download\/[^/]+$/.test(releaseBase)) {
    throw new Error("release base must be an exact GhosterAnti GitHub Release URL");
  }
  return {
    schema: 1,
    version: GHOSTERANTI_VERSION,
    wingetId: "GhosterAnti.GhosterAnti",
    installer: {
      name: basename(installer),
      url: `${releaseBase}/${encodeURIComponent(basename(installer))}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: statSync(installer).size,
    },
  };
}

if (import.meta.main) {
  const [installer, releaseBase, output = "ghosteranti-agent-bootstrap.json"] = process.argv.slice(2);
  if (!installer || !releaseBase) {
    console.error("usage: bun scripts/write-agent-bootstrap-manifest.ts <installer> <exact-release-url> [output]");
    process.exit(1);
  }
  const manifest = buildAgentBootstrapManifest({ installer, releaseBase });
  writeFileSync(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
