import { test, expect, spyOn } from "bun:test";
import { lookupExitLocation, lookupExitTimezone, attachTimezones, lookupProxyExitLocation } from "./geoip.ts";

test("location lookup carries country through IPv4 and IPv6 responses", async () => {
  for (const ipv6 of [false, true]) {
    const location = await lookupExitLocation(null, async (url) => {
      if (ipv6 && url.includes("ip-api.com")) throw new Error("IPv6 only");
      return { json: async () => ipv6
        ? { timezone: "America/Mexico_City", country: "MX" }
        : { status: "success", timezone: "America/Mexico_City", countryCode: "MX" } };
    });
    expect(location).toEqual({ timezone: "America/Mexico_City", country: "MX" });
  }
});

test("country defaults fill missing locales but never replace saved choices without refresh", async () => {
  const profiles = [
    { proxy: proxy("gate.example.net"), timezone: "", locale: undefined as string | undefined },
    { proxy: proxy("gate.example.net"), timezone: "", locale: "fr-CA" },
  ];
  const fetch = async () => ({ json: async () => ({ status: "success", timezone: "America/New_York", countryCode: "MX" }) });
  await attachTimezones(profiles, fetch);
  expect(profiles.map((p) => p.locale)).toEqual(["es-MX", "fr-CA"]);
  await attachTimezones(profiles, fetch, true);
  expect(profiles.map((p) => p.locale)).toEqual(["es-MX", "es-MX"]);
  await attachTimezones(profiles, async () => { throw new Error("offline"); }, true);
  expect(profiles.map((p) => [p.timezone, p.locale])).toEqual([
    ["America/New_York", "es-MX"], ["America/New_York", "es-MX"],
  ]);
});

const proxy = (host: string) => ({ type: "http" as const, host, port: "8080", user: "", pass: "" });

test("connection timezone lookup follows the current connection without a profile proxy", async () => {
  const calls: RequestInit[] = [];
  const timezone = await lookupExitTimezone(null, async (_url, init) => {
    calls.push(init);
    return { json: async () => ({ status: "success", timezone: "Europe/Paris" }) };
  });
  expect(timezone).toBe("Europe/Paris");
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toHaveProperty("proxy");
});

test("connection timezone lookup supports IPv6-only direct connections", async () => {
  const calls: string[] = [];
  const timezone = await lookupExitTimezone(null, async (url, init) => {
    calls.push(url);
    expect(init).not.toHaveProperty("proxy");
    if (url.includes("ip-api.com")) throw new Error("no IPv4 route");
    return { json: async () => ({ timezone: "Europe/Berlin" }) };
  });
  expect(timezone).toBe("Europe/Berlin");
  expect(calls).toHaveLength(2);
});

test("IPv6 fallback gets a fresh timeout after the IPv4 request times out", async () => {
  let attempts = 0;
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() =>
    ++attempts === 1 ? AbortSignal.abort(new DOMException("Timed out", "TimeoutError")) : new AbortController().signal,
  );
  try {
    const timezone = await lookupExitTimezone(null, async (_url, init) => {
      init.signal!.throwIfAborted();
      return { json: async () => ({ timezone: "Europe/Berlin" }) };
    });
    expect(timezone).toBe("Europe/Berlin");
    expect(attempts).toBe(2);
  } finally {
    timeout.mockRestore();
  }
});

test("attachTimezones preserves saved settings instead of guessing from a proxy gateway", async () => {
  const profiles = [
    { proxy: proxy("gate.example.net"), timezone: "America/Toronto" },
    { proxy: null, timezone: "Europe/Paris" },
  ];
  const calls: string[] = [];
  const { resolved } = await attachTimezones(profiles, async (url, init) => {
    calls.push(url);
    // A gateway lookup would return a valid but unrelated location.
    if (init.body) return { json: async () => [{ query: "gate.example.net", status: "success", timezone: "Asia/Tokyo" }] };
    throw new Error("exit lookup unavailable");
  });
  expect(resolved).toBe(0);
  expect(profiles.map((profile) => profile.timezone)).toEqual(["America/Toronto", "Europe/Paris"]);
  expect(calls).toHaveLength(2);
  expect(calls.some((url) => url.includes("/batch"))).toBe(false);
});

test("failed direct lookup reports no timezone", async () => {
  expect(await lookupExitTimezone(null, async () => { throw new Error("offline"); })).toBeNull();
});

test("attachTimezones prefers the timezone of the proxy's exit IP over its host", async () => {
  const profiles = [{ proxy: proxy("gate.example.net"), timezone: "" }];
  const calls: string[] = [];
  const { resolved } = await attachTimezones(profiles, async (url, init) => {
    calls.push(`${url} via ${(init as { proxy?: string }).proxy ?? "direct"}`);
    return { json: async () => ({ status: "success", timezone: "America/Toronto" }) };
  });
  expect(resolved).toBe(1);
  expect(profiles[0]!.timezone).toBe("America/Toronto");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(/^http:\/\/ip-api\.com\/json\/.* via http:\/\/127\.0\.0\.1:\d+$/);
});

test("attachTimezones asks an IPv6 service when the IPv4-only exit lookup fails", async () => {
  const profiles = [{ proxy: proxy("gate.example.net"), timezone: "" }];
  const calls: string[] = [];
  const { resolved } = await attachTimezones(profiles, async (url) => {
    calls.push(url);
    if (url.includes("ip-api.com")) throw new Error("no IPv4 route");
    return { json: async () => ({ ip: "2001:db8::1", timezone: "Europe/Berlin" }) };
  });
  expect(resolved).toBe(1);
  expect(profiles[0]!.timezone).toBe("Europe/Berlin");
  expect(calls[1]).toBe("https://v6.ipinfo.io/json");
});

test("exit location carries the exit IP from the IPv4 and IPv6 services", async () => {
  for (const ipv6 of [false, true]) {
    const location = await lookupExitLocation(null, async (url) => {
      if (ipv6 && url.includes("ip-api.com")) throw new Error("IPv6 only");
      return { json: async () => ipv6
        ? { ip: "2001:DB8:0:0::7", timezone: "Europe/Berlin", country: "DE" }
        : { status: "success", timezone: "Europe/Berlin", countryCode: "DE", query: "203.0.113.7" } };
    });
    expect(location).toEqual({ timezone: "Europe/Berlin", country: "DE", ip: ipv6 ? "2001:db8::7" : "203.0.113.7" });
  }
  const unparsable = await lookupExitLocation(null, async () => ({
    json: async () => ({ status: "success", timezone: "Europe/Berlin", query: "gate" }),
  }));
  expect(unparsable).toStrictEqual({ timezone: "Europe/Berlin", country: undefined });
});

test("proxy exit location is asked through the proxy and reused per proxy for a minute", async () => {
  let clock = 0;
  const calls: string[] = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push(`${url} via ${(init as { proxy?: string }).proxy ?? "direct"}`);
    return { json: async () => ({ status: "success", timezone: `Etc/GMT-${calls.length}`, countryCode: "DE", query: `203.0.113.${calls.length}` }) };
  };
  const opts = { fetchFn, now: () => clock };
  const gateway = { ...proxy("reuse.example.net"), user: "session-a", pass: "p" };
  const first = { timezone: "Etc/GMT-1", country: "DE", ip: "203.0.113.1" };
  expect(await lookupProxyExitLocation(gateway, opts)).toEqual(first);
  expect(calls[0]).toMatch(/^http:\/\/ip-api\.com\/json\/.* via http:\/\/127\.0\.0\.1:\d+$/);
  clock = 59_000;
  // The reused answer carries the exit's timezone with its address.
  expect(await lookupProxyExitLocation({ ...gateway }, opts)).toEqual(first);
  // A changed login, such as a new sticky session, is another exit.
  expect(await lookupProxyExitLocation({ ...gateway, user: "session-b" }, opts))
    .toEqual({ timezone: "Etc/GMT-2", country: "DE", ip: "203.0.113.2" });
  clock = 60_000;
  expect((await lookupProxyExitLocation(gateway, opts))?.ip).toBe("203.0.113.3");
  expect(calls).toHaveLength(3);
});

test("a failed proxy exit lookup reports none and is asked again next time", async () => {
  let fail = true;
  const fetchFn = async () => {
    if (fail) throw new Error("proxy down");
    return { json: async () => ({ status: "success", timezone: "Europe/Berlin", query: "203.0.113.9" }) };
  };
  const gateway = proxy("down.example.net");
  expect(await lookupProxyExitLocation(gateway, { fetchFn })).toBeNull();
  fail = false;
  expect((await lookupProxyExitLocation(gateway, { fetchFn }))?.ip).toBe("203.0.113.9");
});

test("a slow proxy exit lookup stops waiting and its late answer serves the next launch", async () => {
  let answer!: () => void;
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    await new Promise<void>((resolve) => { answer = resolve; });
    return { json: async () => ({ status: "success", timezone: "Europe/Berlin", query: "203.0.113.10" }) };
  };
  const gateway = proxy("slow.example.net");
  expect(await lookupProxyExitLocation(gateway, { fetchFn, waitMs: 20 })).toBeNull();
  while (!calls) await Bun.sleep(1);
  answer();
  expect((await lookupProxyExitLocation(gateway, { fetchFn, waitMs: 1_000 }))?.ip).toBe("203.0.113.10");
  expect(calls).toBe(1);
});
