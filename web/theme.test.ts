import { expect, test } from "bun:test";
import { readThemeChoice, themeCookie } from "./theme.ts";

test("theme cookie survives loopback port changes and wins over local storage", () => {
  expect(readThemeChoice("other=value; ghosteranti.shell.theme=dark", "light")).toBe("dark");
  expect(readThemeChoice("ghosteranti.shell.theme=system", "light")).toBe("system");
  expect(readThemeChoice("ghosteranti.shell.theme=light", "dark")).toBe("light");
});

test("theme selection falls back safely when the cookie is absent or invalid", () => {
  expect(readThemeChoice("", "dark")).toBe("dark");
  expect(readThemeChoice("ghosteranti.shell.theme=invalid", "system")).toBe("system");
  // Dark-first: a first launch or a corrupt cookie opens the palette the shell
  // is designed around, never the light fallback.
  expect(readThemeChoice("ghosteranti.shell.theme=invalid", "invalid")).toBe("dark");
  expect(readThemeChoice("", null)).toBe("dark");
});

test("theme cookie is host-only, persistent, and valid on the loopback HTTP origin", () => {
  expect(themeCookie("dark")).toBe(
    "ghosteranti.shell.theme=dark; Path=/; Max-Age=31536000; SameSite=Strict",
  );
  expect(themeCookie("dark")).not.toContain("Domain=");
  expect(themeCookie("dark")).not.toContain("Secure");
});
