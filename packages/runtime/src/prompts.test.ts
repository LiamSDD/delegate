import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parsePromptFile } from "./prompts";

const directory = new URL("../prompts/", import.meta.url);
const promptFiles = readdirSync(directory).filter((name) => name !== "README.md");

describe("parsePromptFile", () => {
  it("parses the header and body", () => {
    const prompt = parsePromptFile(
      "critic.v3.md",
      "---\nname: critic\nversion: 3\nstatus: active\nintent: Check claims.\ninputs: [claims, sources]\noutput: CriticReport\n---\nBody text\n",
    );
    expect(prompt).toEqual({
      name: "critic",
      version: 3,
      status: "active",
      intent: "Check claims.",
      inputs: ["claims", "sources"],
      output: "CriticReport",
      body: "Body text\n",
    });
  });

  it("accepts mission-scoped names with dot-separated kebab segments", () => {
    const prompt = parsePromptFile(
      "company-xray.synthesis.v1.md",
      "---\nname: company-xray.synthesis\nversion: 1\nstatus: active\nintent: x\ninputs: []\noutput: X\n---\nB",
    );
    expect(prompt.name).toBe("company-xray.synthesis");
    expect(() => parsePromptFile("company-xray..synthesis.v1.md", "---\n---\n")).toThrow();
  });

  it("rejects a file whose name and header disagree", () => {
    expect(() =>
      parsePromptFile(
        "critic.v2.md",
        "---\nname: critic\nversion: 3\nstatus: draft\nintent: x\ninputs: []\noutput: X\n---\nB",
      ),
    ).toThrow(/version/);
  });

  it("rejects files without a header or with a bad name", () => {
    expect(() => parsePromptFile("critic.v1.md", "no header")).toThrow();
    expect(() => parsePromptFile("critic.md", "---\n---\n")).toThrow(/<name>\.v<N>\.md/);
  });
});

describe("packages/runtime/prompts", () => {
  it("contains at least one prompt", () => {
    expect(promptFiles.length).toBeGreaterThan(0);
  });

  it.each(promptFiles)("%s follows the versioned prompt convention", (file) => {
    const prompt = parsePromptFile(file, readFileSync(new URL(file, directory), "utf8"));
    expect(prompt.body.trim().length).toBeGreaterThan(0);
  });
});

describe("prompt change notes", () => {
  it.each([
    "critic.v2.md",
    "editor.v2.md",
    "planner.v3.md",
    "custom-goal.synthesis.v2.md",
    "company-xray.synthesis.v2.md",
    "automation-audit.analyst.v2.md",
    "deep-research.gaps.v2.md",
  ])("%s states what changed", (file) => {
    const prompt = parsePromptFile(file, readFileSync(new URL(file, directory), "utf8"));
    expect(prompt.changes?.length ?? 0).toBeGreaterThan(20);
  });
});
