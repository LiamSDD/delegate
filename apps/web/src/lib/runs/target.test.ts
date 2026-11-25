import { describe, expect, it } from "vitest";

import { repoTarget, runTarget } from "./target";

describe("runTarget", () => {
  it("names a Repo X-ray run by owner/repo, not the GitHub host", () => {
    expect(runTarget({ url: "https://github.com/LiamSDD/claude-ledger" })).toBe(
      "LiamSDD/claude-ledger",
    );
  });

  it("keeps owner/repo when the URL pins a branch", () => {
    expect(runTarget({ url: "https://github.com/sindresorhus/ky/tree/main" })).toBe(
      "sindresorhus/ky",
    );
  });

  it("names a ship run from its repoUrl", () => {
    expect(runTarget({ repoUrl: "https://github.com/a/b.git" })).toBe("a/b");
  });

  it("uses the hostname for company URLs", () => {
    expect(runTarget({ url: "https://www.plausible.io/about" })).toBe("plausible.io");
  });

  it("does not treat a GitHub profile page as a repository", () => {
    expect(repoTarget("https://github.com/LiamSDD")).toBeNull();
    expect(runTarget({ url: "https://github.com/LiamSDD" })).toBe("github.com");
  });
});
