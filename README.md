# GhosterAnti

GhosterAnti is a free, open-source antidetect browser and local-first profile manager. It ships as a desktop application with a dashboard, a local runtime, an AdsPower-compatible Local API, and an MCP server for AI agents.

> **Status:** source distribution. Download the installer from [Releases](https://github.com/GhosterAI/GhosterAnti/releases), or build from source with the steps below.

## Quick facts

- **Is GhosterAnti open source?** Yes. The complete desktop application — dashboard, local runtime, Local API, and MCP server — is Apache-2.0.
- **Which browser engines does it use?** The engine is chosen per profile. New profiles use GhosterAnti Chromium on Windows and GhosterAnti Firefox on macOS and Linux. Each engine is downloaded from its pinned release channel and verified by SHA-256 before launch. CloakBrowser, a third-party engine, stays available for Chromium profiles.
- **Does data stay local?** In Local mode, yes: no account, no cloud traffic, and profiles stay on the computer. Cloud mode requires your own GhosterAnti Cloud deployment.
- **What does it cost?** Nothing. Every feature is free, including both browser engines, which the app downloads and verifies for you.

## Modes

- **Local:** no account and no cloud connection. Profiles stay on the computer.
- **Cloud:** verified accounts, shared workspaces, portable profile synchronization, and device access controls. There is no hosted GhosterAnti Cloud; point the app at your own deployment with `GHOSTERANTI_CLOUD_URL` or the Cloud URL field.

Browser cache, history, downloads, and temporary files remain local in both modes.

## What this repository contains

- React dashboard and Bun/TypeScript sidecar
- Browser profile, group, proxy, and fingerprint management
- Browser engine lifecycle for GhosterAnti Firefox, GhosterAnti Chromium, and CloakBrowser: pinned download, hash verification, launch, and safe close
- Scripts: JavaScript and Python Playwright scripts run across profiles
- Trash for recoverable profile deletes, and bulk Proxy Tools
- Local SQLite profile storage
- Portable session capture and restore
- GhosterAnti Local API (AdsPower-compatible, loopback only)
- MCP server (`ghosteranti-mcp.exe`) with the pinned Playwright MCP tool set for AI agents
- Cloud client for optional profile synchronization against your own backend

## Development

Requirements:

- [Bun](https://bun.sh/)
- A supported CloakBrowser installation for CloakBrowser profiles
- Rust and Tauri prerequisites for desktop builds

```sh
bun install
bun test
bun cli.ts start
```

The dashboard and compatibility API bind to loopback only.

### Environment

| Variable | Purpose |
| --- | --- |
| `GHOSTERANTI_STATE_ROOT` | State directory (database, profiles, extensions) |
| `GHOSTERANTI_CLOUD_URL` | Cloud API base URL for Cloud mode |
| `GHOSTERANTI_SUPABASE_URL` | Auth base URL when it differs from the Cloud URL |
| `GHOSTERANTI_SUPABASE_ANON_KEY` | Anon key for that auth deployment |
| `GHOSTERANTI_FIREFOX_BINARY_PATH` | Use a local Firefox engine build instead of the pinned download |

### Windows desktop

Desktop packaging requires Windows x64, Bun, the Rust MSVC toolchain, WebView2, and Visual Studio C++ Build Tools.

```sh
bun run desktop:prepare
bun run desktop:build:nsis
```

### macOS desktop

Packaging requires an Apple Silicon Mac, Bun, and the Rust toolchain:

```sh
bun run desktop:build:macos
```

### Linux desktop

Packaging requires Linux x64, Bun, the Rust toolchain and the WebKitGTK 4.1 development package:

```sh
bun run desktop:build:linux
```

## Agent browser automation

The Windows build includes `ghosteranti-mcp.exe`. It connects AI agents to the local GhosterAnti runtime through stdio MCP.

```powershell
& "$env:LOCALAPPDATA\GhosterAnti\ghosteranti-mcp.exe" setup --client auto --yes --json
```

Agents can create profiles, open several headful or headless browsers, select one browser, and use the full pinned Playwright MCP tool set. GhosterAnti remains responsible for browser processes, profile locks, capture, and safe close. Local mode needs no account and does not contact a cloud service.

For the same installation session, the helper also provides JSON-only commands:

```powershell
$ghosteranti = "$env:LOCALAPPDATA\GhosterAnti\ghosteranti-mcp.exe"
& $ghosteranti profiles list --json
& $ghosteranti profiles create --name research --json
& $ghosteranti browser open --profile <profile-id> --headless --json
& $ghosteranti playwright run --profile <profile-id> --file .\task.mjs --json
& $ghosteranti browser close --profile <profile-id> --json
```

Extra connector keys created by the helper are returned once, so store them in the remote client's secret settings. Do not put keys in scripts or logs.

## Browser runtime

GhosterAnti Firefox is the antidetect engine for Firefox profiles, built on top of Camoufox. The app downloads the pinned build from its release channel and verifies the archive and executable SHA-256 hashes before launch. Firefox profiles do not support Chrome extensions or CDP.

New profiles use GhosterAnti Chromium on Windows and GhosterAnti Firefox on macOS and Linux. Imported profiles that name no browser get the same default. The Local API creates Chromium profiles on every computer unless a request names Firefox, because its clients use CDP. Chromium profiles use Chromium 155; on macOS and Linux that build is a beta. GhosterAnti downloads it on first use and verifies the pinned archive and executable SHA-256 hashes.

CloakBrowser stays available for Chromium profiles that ask for it. CloakBrowser profiles on one computer can be linked to each other, so use GhosterAnti Chromium or GhosterAnti Firefox for separate identities. GhosterAnti downloads CloakBrowser from its official releases on first use and verifies the pinned archive and executable SHA-256 hashes. The CloakBrowser binary is a third-party component and is not part of this repository or the Apache-2.0 license.

## Security

Report vulnerabilities privately through [GitHub security advisories](https://github.com/GhosterAI/GhosterAnti/security/advisories/new) using the process in [SECURITY.md](SECURITY.md). Do not include cookies, passwords, proxy credentials, TOTP seeds, profile exports, or diagnostic archives in public issues.

## License

GhosterAnti is distributed under [Apache-2.0](LICENSE). The GhosterAnti Firefox engine is open source under MPL-2.0 in its own repository. The CloakBrowser engine is a third-party component under its own license.
