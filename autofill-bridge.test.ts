import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutofillBridge, AutofillTypingError, autofillSitePatterns, keystrokes, matchesAutofillSite, typeIntoPage } from "./autofill-bridge.ts";
import { AUTOFILL_BACKGROUND, autofillExtensionDir } from "./autofill-extension.ts";
import { ProfileStore } from "./store.ts";
import { generateTotp } from "./totp.ts";
import type { LaunchInfo, Profile } from "./types.ts";

const roots: string[] = [];
const stores: ProfileStore[] = [];
const bridges: AutofillBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Typed = { ws: string; target: string; page: string; text: string };

function fixture(typeText = async (_ws: string, _target: string, _page: string, _text: string) => {}) {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-autofill-"));
  roots.push(root);
  const store = new ProfileStore(":memory:");
  stores.push(store);
  const profile: Profile = {
    id: "autofill-test", accId: "1", name: "Test account", group: "", platform: "x.com",
    username: "test-user", password: "test-password", email: "test@example.com",
    emailPassword: "mailbox-only", twofa: "JBSWY3DPEHPK3PXP", proxy: null, ua: "",
    timezone: "", screenWidth: 1920, screenHeight: 1080, fingerprintSeed: 1, cookies: [], seeded: false,
  };
  store.upsertProfile(profile);
  const launch: LaunchInfo = {
    profileId: profile.id, pid: 1, debugPort: 9333, startedAt: 1,
    ws: "ws://127.0.0.1:9333/test", userDataDir: join(root, profile.id),
  };
  store.recordLaunch(launch);
  const typed: Typed[] = [];
  const bridge = new AutofillBridge(store, async (ws, target, page, text) => {
    typed.push({ ws, target, page, text });
    await typeText(ws, target, page, text);
  });
  bridges.push(bridge);
  bridge.listen();
  bridge.install(launch);
  const binding = () => JSON.parse(readFileSync(join(autofillExtensionDir(launch.userDataDir!), "bind.json"), "utf8"));
  const request = (operation = "menu", body: object = {}, token = binding().token) =>
    new Request(`http://127.0.0.1:${bridge.port}/v1/${operation}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const fill = (field: string, url = "https://x.com/i/flow/login", page = url) =>
    request("type", { field, url, page, target: "target-1" });
  return { store, profile, launch, bridge, binding, request, fill, typed };
}

test("matches platform hosts, explicit aliases and custom domains without suffix confusion", () => {
  for (const platform of ["x", "x.com", "twitter", "twitter.com", "https://www.x.com/home"]) {
    for (const host of ["x.com", "www.x.com", "twitter.com", "mobile.twitter.com"]) {
      expect(matchesAutofillSite(platform, `https://${host}/login`)).toBe(true);
    }
    for (const url of ["https://x.com.evil.test", "https://notx.com", "https://example.com", "file:///x.com", "not a url"]) {
      expect(matchesAutofillSite(platform, url)).toBe(false);
    }
  }
  for (const platform of ["example.com", "https://www.example.com/login"]) {
    expect(matchesAutofillSite(platform, "https://app.example.com/signin")).toBe(true);
  }
  for (const platform of ["", undefined, "unknown"]) expect(matchesAutofillSite(platform, "https://x.com")).toBe(false);
  for (const platform of ["instagram", "facebook", "tiktok", "reddit", "linkedin"]) {
    expect(matchesAutofillSite(platform, `https://www.${platform}.com/login`)).toBe(true);
  }
  expect(matchesAutofillSite("telegram", "https://web.telegram.org/a/")).toBe(true);
  expect(matchesAutofillSite("accounts.example.com", "https://other.example.com")).toBe(false);
  expect(autofillSitePatterns("x")).toEqual(["*://*.x.com/*", "*://*.twitter.com/*"]);
  expect(autofillSitePatterns("https://www.example.com/login")).toEqual(["*://*.example.com/*"]);
  expect(autofillSitePatterns("unknown")).toEqual([]);
});

test("menu contains field names and site patterns, never credential values or launch tokens", async () => {
  const f = fixture();
  const response = await f.bridge.handle(f.request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    ok: true, name: "Test account", fields: ["username", "email", "password", "totp"], sites: ["*://*.x.com/*", "*://*.twitter.com/*"],
  });
  expect(JSON.stringify(f.store.getLaunch(f.profile.id)).includes(f.binding().token)).toBe(false);
});

test("types only the selected field into the clicked tab and never returns the value", async () => {
  const f = fixture();
  for (const field of ["username", "email", "password"] as const) {
    const response = await f.bridge.handle(f.fill(field));
    expect(await response.json()).toEqual({ ok: true });
  }
  expect(f.typed.map((entry) => entry.text)).toEqual(["test-user", "test@example.com", "test-password"]);
  expect(f.typed[0]).toEqual({ ws: f.launch.ws, target: "target-1", page: "https://x.com/i/flow/login", text: "test-user" });
  f.store.upsertProfile({ ...f.profile, password: "updated-password" });
  await f.bridge.handle(f.fill("password"));
  expect(f.typed.at(-1)!.text).toBe("updated-password");
  for (const field of ["emailPassword", "twofa", "cookies", "proxy"]) {
    expect((await f.bridge.handle(f.fill(field))).status).toBe(400);
  }
  expect((await f.bridge.handle(f.request("type", { field: "username", url: "https://x.com", page: "https://x.com" }))).status).toBe(400);
  expect(f.typed).toHaveLength(4);
});

test("generates the current authenticator code at fill time", async () => {
  const f = fixture();
  const before = generateTotp(f.profile.twofa)!.code;
  expect(await (await f.bridge.handle(f.fill("totp"))).json()).toEqual({ ok: true });
  expect([before, generateTotp(f.profile.twofa)!.code]).toContain(f.typed[0]!.text);
});

test("missing fields are omitted and cannot be filled", async () => {
  const f = fixture();
  f.store.upsertProfile({ ...f.profile, password: "", email: "", twofa: "" });
  expect((await (await f.bridge.handle(f.request())).json()).fields).toEqual(["username"]);
  for (const field of ["email", "password", "totp"]) expect((await f.bridge.handle(f.fill(field))).status).toBe(404);
  expect(f.typed).toEqual([]);
});

test("rejects missing tokens, unrelated frames or pages, old helper paths and requests after stop", async () => {
  const f = fixture();
  for (const token of ["", "wrong-token"]) expect((await f.bridge.handle(f.request("menu", {}, token))).status).toBe(401);
  expect((await f.bridge.handle(f.fill("username", "https://evil.test"))).status).toBe(403);
  expect((await f.bridge.handle(f.fill("username", "https://x.com/login", "https://evil.test"))).status).toBe(403);
  // The previous helper drew its page panel only after these answered; now they never do.
  for (const operation of ["fields", "fill"]) {
    expect((await f.bridge.handle(f.request(operation, { url: "https://x.com", field: "username" }))).status).toBe(404);
  }
  const request = f.fill("username");
  f.store.clearLaunch(f.profile.id);
  expect((await f.bridge.handle(request)).status).toBe(401);
  expect(f.typed).toEqual([]);
});

test("one fill types at a time and typing failures are reported without values", async () => {
  let release!: () => void;
  const f = fixture(async (_ws, _target, _page, text) => {
    if (text === "test-user") await new Promise<void>((resolve) => { release = resolve; });
    if (text === "test-password") throw new AutofillTypingError("The page changed. Click the field and try again.");
    if (text === "test@example.com") throw new Error("socket test-password");
  });
  const first = f.bridge.handle(f.fill("username"));
  await Bun.sleep(10);
  const busy = await f.bridge.handle(f.fill("email"));
  expect(busy.status).toBe(409);
  expect((await busy.json()).error).toBe("Autofill is still typing.");
  release();
  expect((await first).status).toBe(200);
  expect(await (await f.bridge.handle(f.fill("password"))).json())
    .toEqual({ ok: false, error: "The page changed. Click the field and try again." });
  const failed = await (await f.bridge.handle(f.fill("email"))).text();
  expect(failed.includes("test-password")).toBe(false);
});

test("tokens cannot choose another profile or outlive their launch generation", async () => {
  const f = fixture();
  f.store.upsertProfile({ ...f.profile, id: "other-profile", username: "other-user" });
  const response = await f.bridge.handle(f.request("type", {
    field: "username", url: "https://x.com", page: "https://x.com", target: "target-1", profileId: "other-profile",
  }));
  expect(await response.json()).toEqual({ ok: true });
  expect(f.typed[0]!.text).toBe(f.profile.username);
  const oldRequest = f.request();
  f.store.recordLaunch({ ...f.launch, startedAt: 2 });
  expect((await f.bridge.handle(oldRequest)).status).toBe(401);
  f.bridge.install({ ...f.launch, startedAt: 2 });
  f.bridge.retire(f.profile.id, f.launch);
  expect((await f.bridge.handle(f.request())).status).toBe(200);
});

test("restart refreshes port and token, while retire removes the private binding", async () => {
  const f = fixture();
  const oldToken = f.binding().token;
  f.bridge.close();
  const restarted = new AutofillBridge(f.store);
  bridges.push(restarted);
  restarted.listen();
  expect(f.binding().port).toBe(restarted.port);
  expect(f.binding().token !== oldToken).toBe(true);
  expect((await restarted.handle(f.request("menu", {}, oldToken))).status).toBe(401);
  expect((await restarted.handle(f.request())).status).toBe(200);
  const request = f.request();
  restarted.retire(f.profile.id, f.launch);
  expect((await restarted.handle(request)).status).toBe(401);
  expect(existsSync(join(autofillExtensionDir(f.launch.userDataDir!), "bind.json"))).toBe(false);
});

test("one unwritable survivor helper does not prevent the manager bridge from starting", async () => {
  const f = fixture();
  f.bridge.close();
  const file = join(autofillExtensionDir(f.launch.userDataDir!), "background.js");
  rmSync(file);
  mkdirSync(file);
  const restarted = new AutofillBridge(f.store);
  bridges.push(restarted);
  expect(() => restarted.listen()).not.toThrow();
  expect(restarted.port).toBeGreaterThan(0);
  expect(existsSync(join(autofillExtensionDir(f.launch.userDataDir!), "bind.json"))).toBe(false);
});

test("installed extension adds nothing to pages and its private binding is not web-accessible", async () => {
  const f = fixture();
  const dir = autofillExtensionDir(f.launch.userDataDir!);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  // No content script and no injection permission: the extension cannot touch page DOM or events.
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.permissions).toEqual(["contextMenus", "debugger"]);
  expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
  expect(manifest.web_accessible_resources).toBeUndefined();
  expect(existsSync(join(dir, "content.js"))).toBe(false);
  expect(() => new Function(AUTOFILL_BACKGROUND)).not.toThrow();
  const response = await fetch(f.request());
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
});

test("background builds a browser context menu and sends the clicked tab's target", async () => {
  const f = fixture();
  const menus: any[] = [];
  let clicked: unknown;
  const chrome = {
    runtime: { getURL: (name: string) => "bind:" + name, onStartup: { addListener() {} }, lastError: undefined },
    contextMenus: {
      removeAll: async () => { menus.length = 0; },
      create: (item: object, done: () => void) => { menus.push(item); done(); },
      onClicked: { addListener: (listener: unknown) => { clicked = listener; } },
    },
    debugger: { getTargets: async () => [{ id: "other", tabId: 3, type: "page" }, { id: "target-1", tabId: 7, type: "page" }] },
  };
  const fetcher = async (url: string, init?: RequestInit) => url.startsWith("bind:")
    ? new Response(JSON.stringify(f.binding()))
    : await f.bridge.handle(new Request(url, init));
  const background = new Function("chrome", "fetch", AUTOFILL_BACKGROUND + "\nreturn { refresh, fill };")(chrome, fetcher);
  await background.refresh();
  expect(menus.map((item) => [item.id, item.parentId, item.title])).toEqual([
    ["ghosteranti", undefined, "GhosterAnti · Test account"],
    ["username", "ghosteranti", "Fill username"],
    ["email", "ghosteranti", "Fill email"],
    ["password", "ghosteranti", "Fill password"],
    ["totp", "ghosteranti", "Fill 2FA code"],
  ]);
  for (const item of menus) {
    expect(item.contexts).toEqual(["editable"]);
    expect(item.documentUrlPatterns).toEqual(["*://*.x.com/*", "*://*.twitter.com/*"]);
  }
  expect(typeof clicked).toBe("function");
  const page = "https://x.com/i/flow/login";
  expect(await background.fill({ menuItemId: "password", pageUrl: page }, { id: 7 })).toEqual({ ok: true });
  expect(f.typed).toEqual([{ ws: f.launch.ws, target: "target-1", page, text: "test-password" }]);
  const failed = await background.fill({ menuItemId: "username", pageUrl: page, frameUrl: "https://evil.test/" }, { id: 7 });
  expect(failed.ok).toBe(false);
  expect(menus[1]).toMatchObject({ id: "failure", enabled: false, title: "Last fill failed: This site does not match the profile's platform." });
  await background.fill({ menuItemId: "username", pageUrl: page }, { id: 7 });
  expect(menus.some((item) => item.id === "failure")).toBe(false);
});

async function fakeCdp(url: () => string) {
  const sent: { method: string; params: any; sessionId?: string }[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (request, srv) => srv.upgrade(request) ? undefined : new Response("no", { status: 400 }),
    websocket: {
      message(socket, data) {
        const message = JSON.parse(String(data));
        sent.push({ method: message.method, params: message.params, sessionId: message.sessionId });
        const result = message.method === "Target.getTargetInfo" ? { targetInfo: { targetId: "target-1", type: "page", url: url() } }
          : message.method === "Target.attachToTarget" ? { sessionId: "session-1" } : {};
        socket.send(JSON.stringify({ id: message.id, result }));
      },
    },
  });
  return { sent, url: `ws://127.0.0.1:${server.port}/devtools/browser/test`, stop: () => server.stop(true) };
}

test("types through trusted CDP key events only, with shift for capitals and symbols", async () => {
  const cdp = await fakeCdp(() => "https://x.com/i/flow/login");
  try {
    await typeIntoPage(cdp.url, "target-1", "https://x.com/i/flow/login", "aB1!é", async () => {});
    // No Runtime, DOM or Page domain: nothing a page script can observe besides the keys.
    expect([...new Set(cdp.sent.map((entry) => entry.method))].sort()).toEqual([
      "Input.dispatchKeyEvent", "Input.insertText", "Target.attachToTarget", "Target.detachFromTarget", "Target.getTargetInfo",
    ]);
    const input = cdp.sent.filter((entry) => entry.method.startsWith("Input."));
    expect(input.every((entry) => entry.sessionId === "session-1")).toBe(true);
    expect(input.map((entry) => entry.method === "Input.insertText" ? `text:${entry.params.text}` : `${entry.params.type}:${entry.params.key}`)).toEqual([
      "keyDown:a", "keyUp:a",
      "rawKeyDown:Shift", "keyDown:B", "keyUp:B", "keyUp:Shift",
      "keyDown:1", "keyUp:1",
      "rawKeyDown:Shift", "keyDown:!", "keyUp:!", "keyUp:Shift",
      "text:é",
    ]);
    expect(input.find((entry) => entry.params.key === "!")!.params).toMatchObject({ code: "Digit1", windowsVirtualKeyCode: 49, modifiers: 8, text: "!" });
    expect(cdp.sent.at(-1)).toMatchObject({ method: "Target.detachFromTarget", params: { sessionId: "session-1" } });
  } finally { cdp.stop(); }
});

test("typing stops when the tab navigates away", async () => {
  let url = "https://x.com/i/flow/login";
  const cdp = await fakeCdp(() => url);
  try {
    let presses = 0;
    const typing = typeIntoPage(cdp.url, "target-1", "https://x.com/i/flow/login", "secret", async () => {
      if (cdp.sent.at(-1)?.params?.type === "keyDown" && ++presses === 2) url = "https://evil.test/";
    });
    await expect(typing).rejects.toBeInstanceOf(AutofillTypingError);
    const typedText = cdp.sent.filter((entry) => entry.params?.type === "keyDown").map((entry) => entry.params.text).join("");
    expect(typedText).toBe("se");
    expect(cdp.sent.at(-1)!.method).toBe("Target.detachFromTarget");
  } finally { cdp.stop(); }
});

test("key timing looks like a person typing", () => {
  const steps = keystrokes("Password1", () => 0.5);
  expect(steps.every((step) => step.delay >= 20 && step.delay <= 250)).toBe(true);
  expect(steps.reduce((sum, step) => sum + step.delay, 0)).toBeGreaterThan(9 * 100);
  expect(keystrokes(" ").map((step) => step.params.code)).toEqual(["Space", "Space"]);
});
