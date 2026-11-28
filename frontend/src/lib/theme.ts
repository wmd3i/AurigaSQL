/** Theme and accent preferences: stored per browser, applied as
 *  `data-theme` / `data-accent` on <html> (see the tokens in index.css). */
export type ThemePreference = "light" | "light-yellow" | "dark" | "system";
export type AccentColor = "plain" | "teal" | "indigo" | "violet" | "amber" | "yellow";

export const ACCENTS: AccentColor[] = ["plain", "teal", "indigo", "violet", "amber", "yellow"];

const THEME_KEY = "aurigasql-theme";
const ACCENT_KEY = "aurigasql-accent";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // Storage blocked (private mode etc.): use defaults.
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted, but still applied for this session.
  }
}

export function getThemePreference(): ThemePreference {
  const value = read(THEME_KEY);
  return value === "light" || value === "light-yellow" || value === "dark" || value === "system"
    ? value
    : "light-yellow";
}

export function getAccent(): AccentColor {
  const value = read(ACCENT_KEY);
  return (ACCENTS as string[]).includes(value ?? "") ? (value as AccentColor) : "amber";
}

export function applyTheme(preference: ThemePreference) {
  if (preference === "light-yellow") {
    document.documentElement.dataset.theme = "light-yellow";
    return;
  }
  const dark = preference === "dark" || (preference === "system" && window.matchMedia(DARK_QUERY).matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function applyAccent(accent: AccentColor) {
  document.documentElement.dataset.accent = accent;
}

export function setThemePreference(preference: ThemePreference) {
  write(THEME_KEY, preference);
  applyTheme(preference);
}

export function setAccent(accent: AccentColor) {
  write(ACCENT_KEY, accent);
  applyAccent(accent);
}

/** Apply saved preferences and keep "system" in sync with the OS setting. */
export function initTheme() {
  applyTheme(getThemePreference());
  applyAccent(getAccent());
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (getThemePreference() === "system") applyTheme("system");
  });
}
