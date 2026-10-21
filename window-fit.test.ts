import { test, expect } from "bun:test";
import { claimedScreenArea, fitWindow, watchWindowFit } from "./window-fit.ts";
import { buildNewProfile } from "./create.ts";

const AREA = { left: 0, top: 0, width: 1440, height: 852 };

test("a maximized window larger than the profile's screen becomes its available screen, at the same corner", () => {
  // CDP reports a maximized window with its hidden border; the page reads (0,0,1920,1032).
  expect(fitWindow({ left: -4, top: -4, width: 1928, height: 1040, windowState: "maximized" }, AREA)).toEqual(AREA);
  // On a second monitor to the right, the window stays there.
  expect(fitWindow({ left: 1916, top: -8, width: 1936, height: 1048, windowState: "maximized" }, AREA))
    .toEqual({ left: 1924, top: 0, width: 1440, height: 852 });
  // A Mac reports a zoomed window without a border, below its menu bar.
  expect(fitWindow({ left: 0, top: 25, width: 1470, height: 931, windowState: "maximized" }, AREA))
    .toEqual({ left: 0, top: 25, width: 1440, height: 852 });
  // On a display no larger than the profile's screen, maximized already fits.
  expect(fitWindow({ left: -4, top: -4, width: 1374, height: 736, windowState: "maximized" }, AREA)).toBeNull();
  expect(fitWindow({ left: -8, top: -8, width: 1456, height: 868, windowState: "maximized" }, AREA)).toBeNull();
});

test("a normal window is shrunk only on the side that is too large, and never moved", () => {
  expect(fitWindow({ left: 0, top: 0, width: 936, height: 810, windowState: "normal" }, AREA)).toBeNull();
  expect(fitWindow({ left: 100, top: 20, width: 1700, height: 1000, windowState: "normal" }, AREA))
    .toEqual({ left: 100, top: 20, width: 1440, height: 852 });
  // A window snapped to the left half of a 1920x1080 display keeps its width.
  expect(fitWindow({ left: 0, top: 0, width: 960, height: 1032, windowState: "normal" }, AREA))
    .toEqual({ left: 0, top: 0, width: 960, height: 852 });
  // Position is the user's, even past the claimed screen's edge or on another monitor.
  expect(fitWindow({ left: 2400, top: 300, width: 936, height: 810, windowState: "normal" }, AREA)).toBeNull();
});

test("at a fractional scale a maximized window that fits is not taken for a larger one", () => {
  // 1920x1080 at 125%: the page reads (0,0,1536,826), CDP rounds the window out to (-6,-6,1550,839).
  const maximized = { left: -6, top: -6, width: 1550, height: 839, windowState: "maximized" };
  expect(fitWindow(maximized, { left: 0, top: 0, width: 1536, height: 826 }, 1.25)).toBeNull();
  // Read at scale 1, the 2 px of rounding look like a display larger than the profile's screen.
  expect(fitWindow(maximized, { left: 0, top: 0, width: 1536, height: 826 })).not.toBeNull();
  // A profile whose taskbar is taller than the display's still gets its own available screen.
  expect(fitWindow(maximized, { left: 0, top: 0, width: 1536, height: 816 }, 1.25)).toEqual({ left: 0, top: 0, width: 1536, height: 816 });
  // The slack is only for the rounding of a maximized window's hidden border.
  expect(fitWindow({ left: 0, top: 0, width: 1537, height: 800, windowState: "normal" }, { left: 0, top: 0, width: 1536, height: 826 }, 1.25))
    .toEqual({ left: 0, top: 0, width: 1536, height: 800 });
});

test("at a fractional scale the window asked for is one a page reads as no larger than the profile's screen", () => {
  // 1093x566 at 125% is drawn as 1367x708 device pixels, which a page reads as 1094x567.
  expect(fitWindow({ left: -6, top: -6, width: 1550, height: 839, windowState: "maximized" }, { left: 0, top: 0, width: 1093, height: 566 }, 1.25))
    .toEqual({ left: 0, top: 0, width: 1092, height: 565 });
  expect(fitWindow({ left: 0, top: 0, width: 1700, height: 900, windowState: "normal" }, { left: 0, top: 0, width: 1093, height: 566 }, 1.5))
    .toEqual({ left: 0, top: 0, width: 1092, height: 566 });
});

test("fullscreen and minimized windows are left alone", () => {
  expect(fitWindow({ left: 0, top: 0, width: 1920, height: 1080, windowState: "fullscreen" }, AREA)).toBeNull();
  expect(fitWindow({ left: -32000, top: -32000, width: 160, height: 28, windowState: "minimized" }, AREA)).toBeNull();
});

test("the claimed area is the captured available screen, then the stored capture, then the profile's screen", () => {
  const profile = { ...buildNewProfile({ screen: "1440x900" }, () => false) };
  const screen = { width: 1440, height: 900, availWidth: 1440, availHeight: 852, availLeft: 0, availTop: 0, colorDepth: 24, dpr: 1 };
  expect(claimedScreenArea(profile, { screen })).toEqual(AREA);
  expect(claimedScreenArea(profile, { screen: { ...screen, availTop: 33, availHeight: 781 } })).toEqual({ ...AREA, top: 33, height: 781 });
  // A capture that failed at this launch still has the taskbar from an earlier one.
  expect(claimedScreenArea({ ...profile, fpObserved: { availableScreen: "1440*852" } }, null)).toEqual(AREA);
  expect(claimedScreenArea({ ...profile, fpObserved: { availableScreen: "2560*1392" } }, null)).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  expect(claimedScreenArea(profile, null)).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
});

/**
 * A browser socket whose windows the test sets; records each setWindowBounds. A window that
 * maximize() maximized is restored to the bounds it had before, as Windows restores it.
 */
function fakeBrowser(windows: Map<number, any>, refuse = false) {
  const sets: any[] = [];
  const beforeMaximize = new Map<number, any>();
  let socket: any;
  class FakeSocket {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    closed = false;
    constructor(public url: string) {
      socket = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      let result: any = {};
      if (method === "Target.getTargets") {
        result = { targetInfos: [...windows.keys()].map((w) => ({ type: "page", targetId: `t${w}` })).concat({ type: "service_worker", targetId: "sw" } as any) };
      } else if (method === "Browser.getWindowForTarget") {
        result = { windowId: Number(params.targetId.slice(1)) };
      } else if (method === "Browser.getWindowBounds") {
        result = { bounds: windows.get(params.windowId) };
      } else if (method === "Browser.setWindowBounds") {
        sets.push(params);
        const current = windows.get(params.windowId);
        const restore = params.bounds.windowState === "normal" && current.windowState === "maximized" && beforeMaximize.get(params.windowId);
        if (!refuse) windows.set(params.windowId, restore || { windowState: "normal", ...current, ...params.bounds });
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result }) }));
    }
    close() { this.closed = true; }
  }
  const maximize = (windowId: number, bounds: object) => {
    beforeMaximize.set(windowId, windows.get(windowId));
    windows.set(windowId, { ...bounds, windowState: "maximized" });
  };
  return { sets, maximize, Socket: FakeSocket as unknown as typeof WebSocket, socket: () => socket };
}

/** CDP's bounds of a window maximized on a 1920x1080 display with a 48 px taskbar. */
const MAXIMIZED_1080P = { left: -8, top: -8, width: 1936, height: 1048 };

const ticks = (n: number) => new Promise((r) => setTimeout(r, n * 5 + 5));
/** Waits for the watcher to reach a state; Windows timers fire about every 15.6 ms, not every 5. */
async function settle<T>(read: () => T, expected: T, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !Bun.deepEquals(read(), expected)) await ticks(1);
  expect(read()).toEqual(expected);
}

test("the watcher fixes a maximize at once and a dragged window after it settles", async () => {
  const windows = new Map<number, any>([[1, { left: 0, top: 0, width: 936, height: 810, windowState: "normal" }]]);
  const browser = fakeBrowser(windows);
  const fit = watchWindowFit("ws://fake", AREA, { intervalMs: 5, WebSocket: browser.Socket });
  await ticks(2);
  expect(browser.sets).toEqual([]);

  windows.set(1, { left: -4, top: -4, width: 1928, height: 1040, windowState: "maximized" });
  await ticks(2);
  expect(browser.sets).toEqual([{ windowId: 1, bounds: { windowState: "normal" } }, { windowId: 1, bounds: AREA }]);

  // A drag in progress changes bounds every read; it is fixed only once they hold still.
  for (const width of [1500, 1600, 1700]) {
    windows.set(1, { left: 0, top: 0, width, height: 800, windowState: "normal" });
    await new Promise((r) => setTimeout(r, 4));
  }
  // A short pause in the drag is not yet the end of it.
  await ticks(1);
  expect(browser.sets.length).toBe(2);
  await ticks(8);
  expect(browser.sets.at(-1)).toEqual({ windowId: 1, bounds: { left: 0, top: 0, width: 1440, height: 800 } });
  fit.stop();
  expect(browser.socket().closed).toBe(true);
});

test("on a display larger than the profile's screen, maximize toggles between that screen and the window before", async () => {
  const before = { left: 100, top: 50, width: 936, height: 810, windowState: "normal" };
  const windows = new Map<number, any>([[1, before]]);
  const browser = fakeBrowser(windows);
  const fit = watchWindowFit("ws://fake", AREA, { intervalMs: 5, WebSocket: browser.Socket });
  await ticks(2);
  browser.maximize(1, MAXIMIZED_1080P);
  await settle(() => windows.get(1), { windowState: "normal", ...AREA });
  // Maximizing that window again brings back the window from before, as a restore does.
  browser.maximize(1, MAXIMIZED_1080P);
  await settle(() => windows.get(1), before);
  browser.maximize(1, MAXIMIZED_1080P);
  await settle(() => windows.get(1), { windowState: "normal", ...AREA });
  // Each answer holds: nothing more is sent while the user leaves the window alone.
  const sent = browser.sets.length;
  await ticks(6);
  expect(browser.sets.length).toBe(sent);
  fit.stop();
});

test("a maximized window stays maximized when the display fits the profile's screen, also at 125%", async () => {
  for (const [bounds, area, scale] of [
    [MAXIMIZED_1080P, { left: 0, top: 0, width: 1920, height: 1032 }, 1],
    [MAXIMIZED_1080P, { left: 0, top: 0, width: 1920, height: 1040 }, 1],
    [{ left: -6, top: -6, width: 1550, height: 839 }, { left: 0, top: 0, width: 1536, height: 826 }, 1.25],
  ] as const) {
    const windows = new Map<number, any>([[1, { ...bounds, windowState: "maximized" }]]);
    const browser = fakeBrowser(windows);
    const fit = watchWindowFit("ws://fake", area, { intervalMs: 5, scale, WebSocket: browser.Socket });
    await ticks(4);
    expect(browser.sets).toEqual([]);
    fit.stop();
  }
});

test("a fix the window manager refuses is not repeated", async () => {
  const windows = new Map<number, any>([[1, { left: -4, top: -4, width: 1928, height: 1040, windowState: "maximized" }]]);
  const browser = fakeBrowser(windows, true);
  const fit = watchWindowFit("ws://fake", AREA, { intervalMs: 5, WebSocket: browser.Socket });
  await ticks(8);
  expect(browser.sets.length).toBe(2);
  // Once the user changes the window, it is tried again.
  windows.set(1, { left: -4, top: -4, width: 1928, height: 1041, windowState: "maximized" });
  await ticks(2);
  expect(browser.sets.length).toBe(4);
  fit.stop();
});

test("the watcher ends when the browser closes its socket", async () => {
  const browser = fakeBrowser(new Map());
  let closed = 0;
  watchWindowFit("ws://fake", AREA, { intervalMs: 5, WebSocket: browser.Socket, onClose: () => closed++ });
  await ticks(1);
  browser.socket().onclose();
  browser.socket().onclose();
  expect(closed).toBe(1);
});
