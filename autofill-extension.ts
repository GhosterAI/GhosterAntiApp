import { join } from "node:path";

export const AUTOFILL_EXTENSION_REVISION = 1;
export const autofillExtensionDir = (userDataDir: string) => join(userDataDir, "ghosteranti-autofill");

// No content script and no page UI: the menu is the browser's own context menu,
// and GhosterAnti types the value as real key events, so pages see only typing.
export const AUTOFILL_MANIFEST = {
  manifest_version: 3,
  name: "GhosterAnti Autofill",
  version: "1.0.0",
  description: "Fill saved credentials from this GhosterAnti profile.",
  permissions: ["contextMenus", "debugger"],
  host_permissions: ["http://127.0.0.1/*"],
  background: { service_worker: "background.js" },
};

// Embedded source also ships inside the compiled desktop sidecar.
export const AUTOFILL_BACKGROUND = String.raw`
const titles = { username: "Fill username", email: "Fill email", password: "Fill password", totp: "Fill 2FA code" };
let failure = "";
let queue = Promise.resolve();

async function call(operation, body) {
  const binding = await (await fetch(chrome.runtime.getURL("bind.json"), { cache: "no-store" })).json();
  const response = await fetch("http://127.0.0.1:" + binding.port + "/v1/" + operation, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + binding.token },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return await response.json();
}

function create(item) {
  return new Promise((resolve, reject) => chrome.contextMenus.create(item, () => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve();
  }));
}

async function rebuild() {
  const menu = await call("menu", {});
  // Keep the last good menu while GhosterAnti restarts.
  if (!menu?.ok) return;
  await chrome.contextMenus.removeAll();
  if (!menu.fields.length || !menu.sites.length) return;
  const scope = { contexts: ["editable"], documentUrlPatterns: menu.sites };
  await create({ id: "ghosteranti", title: "GhosterAnti · " + menu.name, ...scope });
  if (failure) await create({ id: "failure", parentId: "ghosteranti", title: failure, enabled: false, ...scope });
  for (const field of menu.fields) if (titles[field]) await create({ id: field, parentId: "ghosteranti", title: titles[field], ...scope });
}

function refresh() {
  return (queue = queue.then(rebuild).catch(() => {}));
}

async function fill(info, tab) {
  if (!titles[info.menuItemId] || tab?.id === undefined) return;
  let result;
  try {
    const target = (await chrome.debugger.getTargets()).find((item) => item.tabId === tab.id && item.type === "page");
    result = target
      ? await call("type", { field: info.menuItemId, url: info.frameUrl || info.pageUrl, page: info.pageUrl, target: target.id })
      : { ok: false, error: "Reload the page and try again." };
  } catch {
    result = { ok: false, error: "Open GhosterAnti to use autofill." };
  }
  failure = result?.ok ? "" : "Last fill failed: " + (result?.error || "Autofill is unavailable. Check GhosterAnti.");
  await refresh();
  return result;
}

chrome.contextMenus.onClicked.addListener((info, tab) => { void fill(info, tab); });
// Wakes the worker at browser start; the refresh below runs on every wake.
chrome.runtime.onStartup.addListener(() => {});
refresh();
`;
