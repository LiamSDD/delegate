export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "delegate-theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

export function toggledPreference(resolved: ResolvedTheme): ThemePreference {
  return resolved === "dark" ? "light" : "dark";
}

export const themeInitScript = [
  `var p="system";`,
  `try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(s==="light"||s==="dark"||s==="system")p=s;}catch(e){}`,
  `var t=p==="system"?(matchMedia(${JSON.stringify(DARK_QUERY)}).matches?"dark":"light"):p;`,
  `var d=document.documentElement.dataset;d.theme=t;d.themePreference=p;`,
].join("");
