import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platformHomeUrl } from "./launcher.ts";
import { AUTOFILL_BACKGROUND, AUTOFILL_MANIFEST, autofillExtensionDir } from "./autofill-extension.ts";
import type { ProfileStore } from "./store.ts";
import { generateTotp } from "./totp.ts";
import type { LaunchInfo } from "./types.ts";

type Generation = Pick<LaunchInfo, "debugPort" | "startedAt">;
type Binding = Generation & { profileId: string; token: string; directory: string };
const FIELDS = ["username", "email", "password", "totp"] as const;

function siteHosts(platform: string | undefined): string[] {
  const raw = platform?.trim().toLowerCase();
  if (!raw) return [];
  try {
    const site = new URL(platformHomeUrl(raw) ?? (raw.includes("://") ? raw : `https://${raw}`));
    if (!["http:", "https:"].includes(site.protocol)) return [];
    const host = site.hostname.replace(/^www\./, "").replace(/\.$/, "");
    if (!host.includes(".")) return [];
    return ["x.com", "twitter.com"].includes(host) ? ["x.com", "twitter.com"] : [host];
  } catch {
    return [];
  }
}

export function matchesAutofillSite(platform: string | undefined, pageUrl: string): boolean {
  const hosts = siteHosts(platform);
  try {
    const page = new URL(pageUrl);
    if (!["http:", "https:"].includes(page.protocol)) return false;
    const actual = page.hostname.replace(/\.$/, "");
    return hosts.some((allowed) => actual === allowed || actual.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

/** Chrome match patterns for the same hosts. `*.host` also matches the host itself. */
export const autofillSitePatterns = (platform: string | undefined) => siteHosts(platform).map((host) => `*://*.${host}/*`);

type KeyStep = { method: "Input.dispatchKeyEvent" | "Input.insertText"; params: Record<string, unknown>; delay: number };
const SHIFTED = '~!@#$%^&*()_+{}|:"<>?';
const UNSHIFTED = "`1234567890-=[]\\;',./";
const PUNCTUATION: Record<string, [string, number]> = {
  "`": ["Backquote", 192], "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
  "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190],
  "/": ["Slash", 191], " ": ["Space", 32],
};
const SHIFT = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, location: 1 };
const between = (random: () => number, low: number, high: number) => Math.round(low + random() * (high - low));

/** US-layout key for a character, or undefined when only text insertion can produce it. */
function usKey(char: string): { code: string; keyCode: number; shift: boolean } | undefined {
  const shifted = SHIFTED.indexOf(char);
  const base = shifted >= 0 ? UNSHIFTED[shifted]! : /^[A-Z]$/.test(char) ? char.toLowerCase() : char;
  const shift = base !== char;
  if (/^[a-z]$/.test(base)) return { code: `Key${base.toUpperCase()}`, keyCode: base.toUpperCase().charCodeAt(0), shift };
  if (/^[0-9]$/.test(base)) return { code: `Digit${base}`, keyCode: base.charCodeAt(0), shift };
  const punctuation = PUNCTUATION[base];
  return punctuation && { code: punctuation[0], keyCode: punctuation[1], shift };
}

/** Trusted key presses with human per-key timing. `delay` is the pause after each step. */
export function keystrokes(text: string, random = Math.random): KeyStep[] {
  const steps: KeyStep[] = [];
  for (const char of text) {
    const key = usKey(char);
    if (!key) {
      steps.push({ method: "Input.insertText", params: { text: char }, delay: between(random, 90, 220) });
      continue;
    }
    const modifiers = key.shift ? 8 : 0;
    const press = { key: char, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers };
    const event = "Input.dispatchKeyEvent" as const;
    if (key.shift) steps.push({ method: event, params: { type: "rawKeyDown", ...SHIFT, modifiers }, delay: between(random, 30, 90) });
    steps.push({ method: event, params: { type: "keyDown", ...press, text: char }, delay: between(random, 45, 110) });
    steps.push({ method: event, params: { type: "keyUp", ...press }, delay: key.shift ? between(random, 20, 60) : between(random, 70, 190) });
    if (key.shift) steps.push({ method: event, params: { type: "keyUp", ...SHIFT, modifiers: 0 }, delay: between(random, 70, 170) });
  }
  return steps;
}

export class AutofillTypingError extends Error {}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function openCdp(ws: string) {
  const socket = new WebSocket(ws);
  let next = 0;
  const pending = new Map<number, [(value: any) => void, (error: Error) => void]>();
  socket.onmessage = (event) => {
    let message: any;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter[1](new Error(message.error.message || "CDP error"));
    else waiter[0](message.result);
  };
  socket.onclose = () => {
    for (const [, reject] of pending.values()) reject(new Error("CDP closed"));
    pending.clear();
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("CDP unavailable"));
  });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error("CDP closed"));
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timed out")); }, 5_000);
    pending.set(id, [(value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }]);
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, close: () => socket.close() };
}

/**
 * Types into the focused field of one page target with Input events only. No
 * Runtime, DOM or Page domain is enabled, so the page sees just trusted keys.
 * Typing stops if the tab navigates or changes URL.
 */
export async function typeIntoPage(ws: string, target: string, page: string, text: string, wait = sleep): Promise<void> {
  const cdp = await openCdp(ws);
  let sessionId: string | undefined;
  const unchanged = async () => {
    const { targetInfo } = await cdp.send("Target.getTargetInfo", { targetId: target });
    if (targetInfo?.type !== "page" || targetInfo.url !== page) {
      throw new AutofillTypingError("The page changed. Click the field and try again.");
    }
  };
  try {
    await unchanged();
    ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true }));
    // A person needs a moment to move from the menu to the keyboard.
    await wait(between(Math.random, 250, 450));
    for (const step of keystrokes(text)) {
      if (step.params.type !== "keyUp") await unchanged();
      await cdp.send(step.method, step.params, sessionId);
      await wait(step.delay);
    }
  } finally {
    if (sessionId) await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    cdp.close();
  }
}

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Tokens belong to one live generation, never to exported profile or launch records. */
export class AutofillBridge {
  private server?: ReturnType<typeof Bun.serve>;
  private profiles = new Map<string, Binding>();
  private tokens = new Map<string, Binding>();
  private typing = new Set<string>();

  constructor(private store: ProfileStore, private typeText = typeIntoPage) {}

  get port(): number {
    return this.server?.port ?? 0;
  }

  listen(): void {
    if (this.server) return;
    this.server = Bun.serve({
      // Typing a long value keeps one request open for several seconds.
      hostname: "127.0.0.1", port: 0, idleTimeout: 60,
      fetch: (request) => this.handle(request),
      error: () => json({ ok: false, error: "Autofill is unavailable." }, 500),
    });
    this.server.unref();
    // Surviving workers reread bind.json, so both the port and token may change.
    for (const launch of this.store.listLaunches()) {
      if (launch.userDataDir && existsSync(join(autofillExtensionDir(launch.userDataDir), "manifest.json"))) {
        try { this.install(launch); } catch {
          console.warn(`[ghosteranti] autofill unavailable for ${launch.profileId}; close and reopen the profile to retry`);
        }
      }
    }
  }

  install(launch: LaunchInfo): void {
    if (!this.port || !launch.userDataDir) throw new Error("autofill bridge or profile directory is unavailable");
    const directory = autofillExtensionDir(launch.userDataDir);
    const binding: Binding = {
      profileId: launch.profileId, debugPort: launch.debugPort, startedAt: launch.startedAt,
      directory, token: randomBytes(32).toString("base64url"),
    };
    const previous = this.profiles.get(launch.profileId);
    if (previous) this.tokens.delete(previous.token);
    this.profiles.set(launch.profileId, binding);
    this.tokens.set(binding.token, binding);
    const temporary = join(directory, "bind.json.tmp");
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(AUTOFILL_MANIFEST));
      writeFileSync(join(directory, "background.js"), AUTOFILL_BACKGROUND);
      writeFileSync(temporary, JSON.stringify({ port: this.port, token: binding.token }), { mode: 0o600 });
      renameSync(temporary, join(directory, "bind.json"));
    } catch {
      this.retire(launch.profileId, launch);
      try { rmSync(temporary, { force: true }); } catch {}
      throw new Error("could not prepare the profile autofill extension");
    }
  }

  retire(profileId: string, generation: Generation): void {
    const binding = this.profiles.get(profileId);
    if (!binding || binding.debugPort !== generation.debugPort || binding.startedAt !== generation.startedAt) return;
    this.profiles.delete(profileId);
    this.tokens.delete(binding.token);
    try { rmSync(join(binding.directory, "bind.json"), { force: true }); } catch {}
  }

  close(): void {
    // Leave files for surviving browsers; a new manager refreshes their binding.
    this.tokens.clear();
    this.profiles.clear();
    this.server?.stop(true);
    this.server = undefined;
  }

  async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // Earlier helper paths stay unknown, so a surviving old helper shows no page UI.
    if (path !== "/v1/menu" && path !== "/v1/type") return json({ ok: false }, 404);
    if (request.method !== "POST") return json({ ok: false }, 405);
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!this.tokens.has(token)) return json({ ok: false, error: "Open GhosterAnti to use autofill." }, 401);
    let body: { url?: unknown; page?: unknown; field?: unknown; target?: unknown } | null;
    try { body = await request.json(); } catch { return json({ ok: false }, 400); }
    // Recheck after reading the body: a stop or replacement may have happened meanwhile.
    const binding = this.tokens.get(token);
    const launch = binding && this.store.getLaunch(binding.profileId);
    if (!binding || !launch || launch.debugPort !== binding.debugPort || launch.startedAt !== binding.startedAt) {
      return json({ ok: false, error: "Reopen this profile to use autofill." }, 401);
    }
    const profile = this.store.getProfile(binding.profileId);
    if (profile && path === "/v1/menu") {
      const fields = FIELDS.filter((field) => field === "totp" ? !!generateTotp(profile.twofa) : !!profile[field]);
      return json({ ok: true, name: profile.name || profile.id, fields, sites: autofillSitePatterns(profile.platform) });
    }
    const { url, page, field, target } = body ?? {};
    if (!profile || typeof url !== "string" || typeof page !== "string" ||
      !matchesAutofillSite(profile.platform, url) || !matchesAutofillSite(profile.platform, page)) {
      return json({ ok: false, error: "This site does not match the profile's platform." }, 403);
    }
    if (!FIELDS.includes(field as typeof FIELDS[number]) || typeof target !== "string") return json({ ok: false }, 400);
    const key = field as typeof FIELDS[number];
    const value = key === "totp" ? generateTotp(profile.twofa)?.code : profile[key];
    if (!value) return json({ ok: false, error: "No saved value for this field. Edit the profile in GhosterAnti." }, 404);
    if (this.typing.has(binding.profileId)) return json({ ok: false, error: "Autofill is still typing." }, 409);
    this.typing.add(binding.profileId);
    try {
      await this.typeText(launch.ws, target, page, value);
      return json({ ok: true });
    } catch (error) {
      const message = error instanceof AutofillTypingError ? error.message : "Autofill could not type. Click the field and try again.";
      return json({ ok: false, error: message }, 409);
    } finally {
      this.typing.delete(binding.profileId);
    }
  }
}
