import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const transportStatsKey = Symbol.for("ghosteranti.playwrightTransportStats");
const require = createRequire(import.meta.url);
const transportPath = fileURLToPath(
  new URL("./node_modules/playwright-core/lib/server/transport.js", import.meta.url),
);
const browserContextPath = fileURLToPath(
  new URL("./node_modules/playwright-core/lib/server/browserContext.js", import.meta.url),
);
const chromiumBrowserPath = fileURLToPath(
  new URL("./node_modules/playwright-core/lib/server/chromium/crBrowser.js", import.meta.url),
);

function transportStats() {
  return (globalThis as any)[transportStatsKey] as {
    opened: number;
    closed: number;
    forced: number;
    active: number;
  };
}

class FakeSocket extends EventEmitter {
  readyState = 1;
  closeCalls = 0;
  terminateCalls = 0;

  constructor(private readonly closeGracefully: boolean) {
    super();
  }

  addEventListener(event: string, listener: (...args: any[]) => void) {
    this.on(event, listener);
  }

  close() {
    this.closeCalls++;
    if (this.closeGracefully) this.finishClose();
  }

  terminate() {
    this.terminateCalls++;
    this.finishClose();
  }

  private finishClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "" });
  }
}

function fakeTransport(WebSocketTransport: any, socket: FakeSocket) {
  const transport = Object.create(WebSocketTransport.prototype);
  Object.assign(transport, {
    _ws: socket,
    _progress: undefined,
    _logUrl: "test",
    _closeTimer: undefined,
    _closeRequested: false,
    _closed: false,
  });
  socket.addEventListener("close", () => transport._didClose());
  transportStats().opened = 1;
  transportStats().active = 1;
  return transport;
}

describe("Playwright CDP compatibility patch", () => {
  const { WebSocketTransport } = require(transportPath);

  beforeEach(() => {
    Object.assign(transportStats(), { opened: 0, closed: 0, forced: 0, active: 0 });
  });

  test("pins the patched Playwright version and installs its external WebSocket dependency", async () => {
    const packageJson = await Bun.file(new URL("./package.json", import.meta.url)).json() as {
      dependencies?: Record<string, string>;
      patchedDependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.["playwright-core"]).toBe("1.58.2");
    expect(packageJson.dependencies?.ws).toBe("8.21.0");
    expect(packageJson.patchedDependencies?.["playwright-core@1.58.2"])
      .toBe("patches/playwright-core@1.58.2.patch");
  });

  test("installs the external ws and hardened transport patch", async () => {
    const patch = await Bun.file(
      new URL("./patches/playwright-core@1.58.2.patch", import.meta.url),
    ).text();
    const installed = await Bun.file(new URL(
      "./node_modules/playwright-core/lib/server/transport.js",
      import.meta.url,
    )).text();
    const installedContext = await Bun.file(new URL(
      "./node_modules/playwright-core/lib/server/browserContext.js",
      import.meta.url,
    )).text();
    const installedChromium = await Bun.file(new URL(
      "./node_modules/playwright-core/lib/server/chromium/crBrowser.js",
      import.meta.url,
    )).text();

    for (const source of [patch, installed]) {
      expect(source).toContain("const perMessageDeflate = false");
      expect(source).toContain("const kWebSocketCloseTimeout = 5e3");
      expect(source).toContain("this._ws.terminate()");
      expect(source).not.toContain("closeTimeout:");
    }
    expect(patch).toContain('const _rawWs = require("ws")');
    for (const source of [patch, installedContext]) {
      expect(source).toContain("if (!options.name && !options.domain && !options.path)");
    }
    for (const source of [patch, installedChromium]) {
      expect(source).toContain('browserContextId: this._browserContextId, background: true');
    }
    expect(installed.match(/(?:this|transport)\._ws\.close\(\)/g)).toHaveLength(1);
  });

  test("creates internal Chromium pages without activating a minimized window", async () => {
    const { CRBrowserContext } = require(chromiumBrowserPath);
    const sent: Array<{ method: string; params: unknown }> = [];
    const page = {};
    const context = Object.create(CRBrowserContext.prototype);
    Object.assign(context, {
      _browserContextId: "context-1",
      _browser: {
        _session: {
          async send(method: string, params: unknown) {
            sent.push({ method, params });
            return { targetId: "target-1" };
          },
        },
        _crPages: new Map([["target-1", { _page: page }]]),
      },
    });

    expect(await CRBrowserContext.prototype.doCreateNewPage.call(context)).toBe(page);
    expect(sent).toEqual([{
      method: "Target.createTarget",
      params: { url: "about:blank", browserContextId: "context-1", background: true },
    }]);
  });

  test("attaching to an open tab never emulates its colour scheme, and GhosterAnti's helpers not its focus", async () => {
    // A browser with one open tab, as GhosterAnti's helpers find it after a launch.
    const tabMethods: string[] = [];
    const emulatedMedia: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request, srv) => srv.upgrade(request) ? undefined : new Response("no", { status: 400 }),
      websocket: {
        message(ws, raw) {
          const { id, method, sessionId, params } = JSON.parse(String(raw));
          if (sessionId) tabMethods.push(method);
          if (method === "Emulation.setEmulatedMedia") emulatedMedia.push(params);
          const result = method === "Browser.getVersion"
            ? { product: "Chrome/155.0.0.0", userAgent: "Chrome/155.0.0.0" }
            : method === "Page.getFrameTree"
              ? { frameTree: { frame: { id: "tab", loaderId: "load", url: "https://example.com/", securityOrigin: "https://example.com", mimeType: "text/html" } } }
              : {};
          ws.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }));
          if (method === "Target.setAutoAttach" && !sessionId) {
            ws.send(JSON.stringify({ method: "Target.attachedToTarget", params: {
              sessionId: "tab-session",
              targetInfo: { targetId: "tab", type: "page", title: "", url: "https://example.com/", attached: true, canAccessOpener: false, browserContextId: "default" },
              waitingForDebugger: false,
            } }));
          }
        },
      },
    });
    const { chromium } = require("playwright-core");
    const switchKey = Symbol.for("ghosteranti.playwrightFocusEmulation");
    const attach = async (focusEmulation: boolean | undefined) => {
      tabMethods.length = 0;
      (globalThis as any)[switchKey] = focusEmulation;
      try {
        const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${server.port}/devtools/browser/test`, { timeout: 5_000 });
        await browser.close();
      } finally {
        delete (globalThis as any)[switchKey];
      }
      return [...tabMethods];
    };
    try {
      const helper = await attach(false);
      expect(helper).toContain("Runtime.runIfWaitingForDebugger");
      expect(helper).not.toContain("Emulation.setFocusEmulationEnabled");
      // Other Playwright users, such as the agent runner, keep Playwright's default.
      expect(await attach(undefined)).toContain("Emulation.setFocusEmulationEnabled");
      // No attach changes the colour scheme, motion, forced colours or contrast the open tab sees.
      expect(emulatedMedia).toHaveLength(2);
      for (const sent of emulatedMedia) {
        expect(sent).toEqual({ media: "", features: ["prefers-color-scheme", "prefers-reduced-motion", "forced-colors", "prefers-contrast"].map((name) => ({ name, value: "" })) });
      }
    } finally {
      server.stop(true);
    }
  });

  test("Firefox hides storage helpers but keeps normal pages visible", async () => {
    const { FFBrowserContext } = require(fileURLToPath(new URL(
      "./node_modules/playwright-core/lib/server/firefox/ffBrowser.js", import.meta.url,
    )));
    const sent: Array<{ method: string; params: unknown }> = [];
    const page = {};
    const context = Object.create(FFBrowserContext.prototype);
    Object.assign(context, {
      _browserContextId: "context-1",
      _browser: {
        session: {
          async send(method: string, params: unknown) {
            sent.push({ method, params });
            return { targetId: "target-1" };
          },
        },
        _ffPages: new Map([["target-1", { _page: page }]]),
      },
    });
    for (const storagePage of [false, true, false]) {
      context._creatingStorageStatePage = storagePage;
      expect(await context.doCreateNewPage()).toBe(page);
      expect(sent.at(-1)).toEqual({
        method: "Browser.newPage",
        params: { browserContextId: "context-1", ...(storagePage ? { hidden: true } : {}) },
      });
    }
  });

  test("unfiltered cookie clearing skips the unnecessary cookie read", async () => {
    const { BrowserContext } = require(browserContextPath);
    const events: string[] = [];
    const context = {
      async cookies() {
        events.push("read");
        return [
          { name: "keep", value: "1", domain: ".x.com", path: "/" },
          { name: "remove", value: "2", domain: ".x.com", path: "/" },
        ];
      },
      async doClearCookies() { events.push("clear"); },
      async addCookies(cookies: any[]) { events.push(`add:${cookies.map((cookie) => cookie.name).join(",")}`); },
    };

    await BrowserContext.prototype.clearCookies.call(context, {});
    expect(events).toEqual(["clear"]);

    events.length = 0;
    await BrowserContext.prototype.clearCookies.call(context, { name: "remove" });
    expect(events).toEqual(["read", "clear", "add:keep"]);
  });

  test("graceful close clears the fallback without terminating", async () => {
    const socket = new FakeSocket(true);
    const transport = fakeTransport(WebSocketTransport, socket);

    await transport.closeAndWait(5);
    await Bun.sleep(10);

    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(0);
    expect(transportStats()).toEqual({ opened: 1, closed: 1, forced: 0, active: 0 });
  });

  test("stalled and repeated closes force-terminate exactly once", async () => {
    const socket = new FakeSocket(false);
    const transport = fakeTransport(WebSocketTransport, socket);

    const closed = transport.closeAndWait(5);
    transport.close(5);
    transport.close(5);
    await closed;
    transport._didClose();

    expect(socket.closeCalls).toBe(1);
    expect(socket.terminateCalls).toBe(1);
    expect(transportStats()).toEqual({ opened: 1, closed: 1, forced: 1, active: 0 });
  });
});
