export const THEME_KEY = "ghosteranti.shell.theme";

export type ThemeChoice = "system" | "light" | "dark";

function validTheme(value: string | null | undefined): value is ThemeChoice {
  return value === "system" || value === "light" || value === "dark";
}

export function readThemeChoice(cookieHeader: string, stored: string | null): ThemeChoice {
  const prefix = `${THEME_KEY}=`;
  for (const part of cookieHeader.split(";")) {
    const cookie = part.trim();
    if (!cookie.startsWith(prefix)) continue;
    const value = cookie.slice(prefix.length);
    if (validTheme(value)) return value;
  }
  // Dark is the out-of-the-box theme: the shell is designed dark-first, and a
  // first launch that opened light would show the palette the product is not
  // built around. Light and follow-the-OS System stay one click away.
  return validTheme(stored) ? stored : "dark";
}

export function themeCookie(choice: ThemeChoice): string {
  return `${THEME_KEY}=${choice}; Path=/; Max-Age=31536000; SameSite=Strict`;
}
