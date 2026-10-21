import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ProfileStore } from "./store.ts";
import { generateTotp } from "./totp.ts";
import type { Profile } from "./types.ts";

// Opt-in like proxy-live.test.ts. Uses only synthetic accounts and intercepted pages.
const browserPath = process.env.GHOSTERANTI_AUTOFILL_BROWSER;
const browserTest = browserPath ? test : test.skip;

// Records what page scripts could see: every DOM change outside the app and every input event.
const PAGE_PROBE = `(() => {
  window.__autofillProbe = { foreign: [], events: [] };
  addEventListener("DOMContentLoaded", () => new MutationObserver((records) => {
    for (const record of records) {
      if (!record.target.closest?.("#app") && !record.target.parentElement?.closest("#app")) {
        window.__autofillProbe.foreign.push(record.type + ":" + record.target.nodeName + ":" + [...record.addedNodes].map((node) => node.nodeName));
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true }));
  for (const type of ["keydown", "keyup", "beforeinput", "input"]) {
    addEventListener(type, (event) => window.__autofillProbe.events.push({ type, trusted: event.isTrusted, key: event.key }), true);
  }
})()`;

/** Same call the browser makes when the user picks an item in the field's context menu. */
async function fillFromMenu(page: Page, field: string, frameUrl?: string) {
  const context = page.context();
  const worker = context.serviceWorkers().find((item) => item.url().endsWith("/background.js"))
    ?? await context.waitForEvent("serviceworker", { predicate: (item) => item.url().endsWith("/background.js") });
  const cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.detach();
  return await worker.evaluate(async ({ targetId, field, frameUrl }) => {
    const scope = globalThis as any;
    const tab = (await scope.chrome.debugger.getTargets()).find((item: any) => item.id === targetId);
    return await scope.fill({ menuItemId: field, pageUrl: tab.url, frameUrl }, { id: tab.tabId });
  }, { targetId: targetInfo.targetId, field, frameUrl });
}

/** Keys arrive as trusted presses and nothing appears in the page DOM. */
async function expectOnlyTyping(page: Page, typed: string) {
  const probe = await page.evaluate(() => (window as any).__autofillProbe);
  expect(probe.foreign).toEqual([]);
  expect(probe.events.every((event: { trusted: boolean }) => event.trusted)).toBe(true);
  const presses = (type: string) => probe.events.filter((event: any) => event.type === type && event.key !== "Shift").length;
  expect(presses("keydown")).toBeGreaterThanOrEqual(typed.length);
  expect(presses("keyup")).toBe(presses("keydown"));
}

browserTest("profile extension fills multi-step React forms, new tabs and surviving browsers", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghosteranti-autofill-browser-"));
  const db = join(root, "profiles.sqlite");
  writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1, mode: "local", localAnalytics: false }));
  const store = new ProfileStore(db);
  const profile: Profile = {
    id: "autofill-one", accId: "1", name: "Autofill test", group: "", platform: "x.com",
    username: "test-one", password: "synthetic-password", email: "test@example.com", twofa: "JBSWY3DPEHPK3PXP",
    proxy: null, ua: "", timezone: "UTC", screenWidth: 1280, screenHeight: 900, fingerprintSeed: 1, cookies: [], seeded: false,
  };
  store.upsertProfile(profile);
  store.upsertProfile({ ...profile, id: "autofill-two", username: "test-two", fingerprintSeed: 2 });
  store.close();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const browsers: Browser[] = [];
  let base = "";
  const startApp = async () => {
    const app = Bun.spawn([
      process.execPath, "cli.ts", "serve", "--state-root", root, "--db", db,
      "--data-root", join(root, "profiles"), "--port", "0", "--no-sandbox", "--unsafe-disable-identity-gates",
    ], {
      cwd: import.meta.dir,
      env: { ...process.env, CLOAKBROWSER_BINARY_PATH: browserPath!, GHOSTERANTI_PLAYWRIGHT_RUNTIME: "" },
      stdout: "pipe", stderr: "pipe",
    });
    child = app;
    let resolveReady!: (url: string) => void;
    const ready = new Promise<string>((resolve) => { resolveReady = resolve; });
    const drain = (async () => {
      let text = "";
      const reader = app.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          const match = text.match(/dashboard \+ API on (http:\/\/127\.0\.0\.1:\d+)/);
          if (match) resolveReady(match[1]!);
        }
      } finally { reader.releaseLock(); }
    })();
    // Drain stderr without putting browser or app environment in assertion output.
    void new Response(app.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      base = await Promise.race([
        ready,
        app.exited.then(() => { throw new Error("autofill test app exited before ready"); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("autofill test app did not start")), 30_000); }),
      ]);
    } finally { clearTimeout(timer); }
    void drain;
  };
  const api = async (path: string, init?: RequestInit) => {
    const response = await fetch(base + path, init);
    expect(response.ok).toBe(true);
    return await response.json();
  };
  try {
    const fixture = join(root, "fixture.jsx");
    writeFileSync(fixture, `
          import React, { useState } from ${JSON.stringify(require.resolve("react"))};
          import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
          function App() {
            const [step, setStep] = useState(0), [value, setValue] = useState(''), [submits, setSubmits] = useState(0);
            const fields = [
              { name: 'text', type: 'text', auto: 'username', label: 'Username' },
              { name: 'text', type: 'text', auto: 'email', label: 'Confirm email' },
              { name: 'password', type: 'password', auto: 'current-password', label: 'Password' },
              { name: 'challenge_response', type: 'text', auto: 'one-time-code', label: 'Authentication code' }
            ];
            const field = fields[step];
            return <main style={{ margin: '100px auto', maxWidth: 420, fontFamily: 'system-ui' }}>
              <h1>Sign in</h1><p>GhosterAnti autofill test · synthetic account</p>
              <form onSubmit={e => { e.preventDefault(); setSubmits(submits + 1); }}>
                <label htmlFor="credential">{field.label}</label><br/>
                <input key={step} id="credential" name={field.name} type={field.type} autoComplete={field.auto}
                  aria-label={field.label} value={value} onChange={e => setValue(e.target.value)}
                  style={{ width: '100%', padding: 12, margin: '8px 0 16px' }}/>
                <button id="next" type="button" onClick={() => { setStep((step + 1) % fields.length); setValue(''); }}>Next</button>
                <output id="value">{value}</output><output id="submits">{submits}</output>
              </form></main>;
          }
          createRoot(document.getElementById('app')).render(<App/>);
    `);
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react" } }));
    const built = await Bun.build({ entrypoints: [fixture], target: "browser" });
    expect(built.success).toBe(true);
    const script = await built.outputs[0]!.text();
    const html = '<!doctype html><meta charset="utf-8"><title>Autofill test</title><div id="app"></div><script src="/fixture.js"></script>';
    await startApp();
    const open = async (id: string) => {
      const query = new URLSearchParams({ user_id: id, launch_args: JSON.stringify([base + "/api/v1/status"]) });
      const result = await api("/api/v1/browser/start?" + query);
      expect(result.code).toBe(0);
      const browser = await chromium.connectOverCDP(result.data.ws.puppeteer);
      browsers.push(browser);
      const context = browser.contexts()[0]!;
      await context.addInitScript(PAGE_PROBE);
      await context.route("https://**/*", (route) => route.fulfill({
        contentType: new URL(route.request().url()).pathname === "/fixture.js" ? "text/javascript" : "text/html",
        body: new URL(route.request().url()).pathname === "/fixture.js" ? script : html,
      }));
      const page = await context.newPage();
      await page.goto("https://x.com/i/flow/login");
      return page;
    };
    const page = await open(profile.id);
    const input = page.locator("#credential");
    await input.click();
    expect(await fillFromMenu(page, "username")).toEqual({ ok: true });
    await page.waitForFunction(() => document.querySelector("#value")?.textContent === "test-one");
    expect(await input.inputValue()).toBe(profile.username);
    expect(await page.locator("#submits").textContent()).toBe("0");
    await page.locator("#next").click();
    await input.click();
    await fillFromMenu(page, "email");
    await page.waitForFunction(() => document.querySelector("#value")?.textContent === "test@example.com");
    await page.locator("#next").click();
    await input.click();
    await fillFromMenu(page, "password");
    await page.waitForFunction(() => document.querySelector("#value")?.textContent === "synthetic-password");
    await page.locator("#next").click();
    await input.click();
    const beforeCode = generateTotp(profile.twofa)!.code;
    await fillFromMenu(page, "totp");
    await page.waitForFunction(() => document.querySelector("#value")?.textContent?.length === 6);
    expect([beforeCode, generateTotp(profile.twofa)!.code]).toContain(await input.inputValue());
    expect(await page.locator("#submits").textContent()).toBe("0");
    await expectOnlyTyping(page, "test-one" + "test@example.com" + "synthetic-password" + beforeCode);

    const second = await open("autofill-two");
    await second.locator("#credential").click();
    await fillFromMenu(second, "username");
    await second.waitForFunction(() => document.querySelector("#value")?.textContent === "test-two");
    const tab = await page.context().newPage();
    await tab.goto("https://twitter.com/login");
    await tab.locator("#credential").click();
    await fillFromMenu(tab, "username");
    await tab.waitForFunction(() => document.querySelector("#value")?.textContent === "test-one");
    await expectOnlyTyping(tab, "test-one");
    const edited = await api(`/ui/api/profiles/${profile.id}/update`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ set: { username: "updated-user" } }),
    });
    expect(edited.ok).toBe(true);
    // Filling types at the caret like a person, so clear the field first.
    await tab.locator("#credential").fill("");
    await tab.locator("#credential").click();
    await fillFromMenu(tab, "username");
    await tab.waitForFunction(() => document.querySelector("#value")?.textContent === "updated-user");

    await tab.locator("#credential").fill("");
    child!.kill("SIGKILL");
    await child!.exited;
    await startApp();
    await tab.locator("#credential").click();
    await fillFromMenu(tab, "username");
    await tab.waitForFunction(() => document.querySelector("#value")?.textContent === "updated-user");
    expect(await tab.locator("#credential").inputValue()).toBe("updated-user");
    await tab.bringToFront();
    await tab.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "login-frame";
      frame.src = "https://unrelated.test/login";
      frame.width = "700";
      frame.height = "500";
      document.body.append(frame);
    });
    const frame = tab.frameLocator("#login-frame");
    await frame.locator("#credential").click();
    expect((await fillFromMenu(tab, "username", "https://unrelated.test/login")).ok).toBe(false);
    expect(await frame.locator("#credential").inputValue()).toBe("");
    const frameNavigation = tab.waitForEvent("framenavigated", { predicate: (value) => value.url() === "https://x.com/login" });
    await tab.locator("#login-frame").evaluate((element) => { (element as HTMLIFrameElement).src = "https://x.com/login"; });
    const matchingFrame = await frameNavigation;
    await matchingFrame.waitForLoadState("load");
    await frame.locator("#credential").click();
    expect(await fillFromMenu(tab, "username", "https://x.com/login")).toEqual({ ok: true });
    expect(await frame.locator("#credential").inputValue()).toBe("updated-user");
    await tab.goto("https://x.com.evil.test/login");
    await tab.locator("#credential").click();
    expect((await fillFromMenu(tab, "username")).ok).toBe(false);
    expect(await tab.locator("#credential").inputValue()).toBe("");
  } finally {
    for (const browser of browsers) {
      try { await (await browser.newBrowserCDPSession()).send("Browser.close"); } catch {}
      await browser.close().catch(() => {});
    }
    if (child && child.exitCode === null) {
      for (const id of [profile.id, "autofill-two"]) {
        await fetch(base + "/api/v1/browser/stop?user_id=" + id, { signal: AbortSignal.timeout(15_000) }).catch(() => {});
      }
    }
    if (child) { child.kill(); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
