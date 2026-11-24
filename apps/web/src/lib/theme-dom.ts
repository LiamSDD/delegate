import {
  DARK_QUERY,
  parseThemePreference,
  type ResolvedTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
  toggledPreference,
} from "./theme";

function root(): HTMLElement {
  return document.documentElement;
}

export function currentResolvedTheme(): ResolvedTheme {
  const applied = root().dataset.theme;
  if (applied === "light" || applied === "dark") return applied;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function currentPreference(): ThemePreference {
  return parseThemePreference(root().dataset.themePreference);
}

export function applyPreference(preference: ThemePreference): void {
  const resolved = resolveTheme(preference, window.matchMedia(DARK_QUERY).matches);
  root().dataset.theme = resolved;
  root().dataset.themePreference = preference;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    return;
  }
}

export function toggleTheme(): void {
  applyPreference(toggledPreference(currentResolvedTheme()));
}

export function subscribeToTheme(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  const onSystemChange = () => {
    if (currentPreference() === "system") applyPreference("system");
  };
  const observer = new MutationObserver(onChange);
  observer.observe(root(), { attributes: true, attributeFilter: ["data-theme"] });
  media.addEventListener("change", onSystemChange);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", onSystemChange);
  };
}
