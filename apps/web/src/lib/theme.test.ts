import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  themeInitScript,
  toggledPreference,
} from "./theme";

interface FakeEnv {
  stored: string | null;
  prefersDark: boolean;
  throwsOnStorage?: boolean;
}

function runInitScript(env: FakeEnv): {
  theme: string | undefined;
  preference: string | undefined;
} {
  const dataset: Record<string, string> = {};
  const document = { documentElement: { dataset } };
  const localStorage = {
    getItem: (key: string) => {
      if (env.throwsOnStorage === true) throw new Error("denied");
      return key === THEME_STORAGE_KEY ? env.stored : null;
    },
  };
  const matchMedia = (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" && env.prefersDark,
  });
  runInNewContext(themeInitScript, { document, localStorage, matchMedia });
  return { theme: dataset.theme, preference: dataset.themePreference };
}

describe("parseThemePreference", () => {
  it("accepts the three known values", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("system")).toBe("system");
  });

  it("falls back to system for anything else", () => {
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("purple")).toBe("system");
    expect(parseThemePreference(1)).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("follows the system only when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("toggledPreference", () => {
  it("switches to the explicit opposite of what is on screen", () => {
    expect(toggledPreference("light")).toBe("dark");
    expect(toggledPreference("dark")).toBe("light");
  });
});

describe("themeInitScript", () => {
  it("applies a stored explicit theme", () => {
    expect(runInitScript({ stored: "dark", prefersDark: false })).toEqual({
      theme: "dark",
      preference: "dark",
    });
  });

  it("resolves the system theme when nothing valid is stored", () => {
    expect(runInitScript({ stored: null, prefersDark: true })).toEqual({
      theme: "dark",
      preference: "system",
    });
    expect(runInitScript({ stored: "neon", prefersDark: false })).toEqual({
      theme: "light",
      preference: "system",
    });
  });

  it("still resolves the system theme when storage is unavailable", () => {
    expect(runInitScript({ stored: "dark", prefersDark: true, throwsOnStorage: true })).toEqual({
      theme: "dark",
      preference: "system",
    });
  });
});
