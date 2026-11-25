import { CAPABILITIES } from "@delegate/policy";
import { z } from "zod";

import { type RunContext } from "../../agent/context";
import { confinePath } from "../../sandbox/paths";
import { type Sandbox } from "../../sandbox/types";
import { defineTool, type RegisteredTool } from "../../tools/registry";
import { commandLabel, type ProjectCommand, type ProjectProfile } from "./detect";
import { SHIP_TIMEOUTS, runInSandbox } from "./workspace";

export const ENGINEER_TOOL_LIMITS = {
  readBytes: 64_000,
  readLines: 400,
  writeBytes: 200_000,
  listEntries: 200,
  searchMatches: 80,
  searchPatternChars: 200,
  commandOutputChars: 3_000,
} as const;

export const ENGINEER_TOOL_NAMES = [
  "read_file",
  "list_dir",
  "search",
  "write_file",
  "run",
] as const;

export const READ_ONLY_COMMANDS: Record<string, ProjectCommand> = {
  git_status: { argv: ["git", "status", "--short"], source: "read-only allowlist" },
  git_diff: { argv: ["git", "diff", "--stat"], source: "read-only allowlist" },
};

export function allowedCommands(profile: ProjectProfile): Record<string, ProjectCommand> {
  const commands: Record<string, ProjectCommand> = { ...READ_ONLY_COMMANDS };
  if (profile.commands.test !== null) commands.test = profile.commands.test;
  if (profile.commands.lint !== null) commands.lint = profile.commands.lint;
  if (profile.commands.typecheck !== null) commands.typecheck = profile.commands.typecheck;
  return commands;
}

export interface EngineerToolsOptions {
  ctx: RunContext;
  sandbox: () => Promise<Sandbox>;
  profile: ProjectProfile;
  onWrite?: (path: string) => void;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8_000).includes(0);
}

export function createEngineerTools(options: EngineerToolsOptions): RegisteredTool[] {
  const { ctx, profile } = options;
  const commands = allowedCommands(profile);
  const commandIds = Object.keys(commands);

  const readFile = defineTool({
    name: "read_file",
    description: `Read a text file in the repository. Paths are relative to the repository root. Returns at most ${ENGINEER_TOOL_LIMITS.readLines} lines from startLine (1-based).`,
    capability: CAPABILITIES.sandboxRead,
    inputSchema: z.object({
      path: z.string().min(1).max(400),
      startLine: z.number().int().min(1).max(1_000_000).optional(),
    }),
    targetDomain: () => undefined,
    summariseArgs: (input) => `read ${input.path}`,
    execute: async (input) => {
      const sandbox = await options.sandbox();
      const target = await confinePath(sandbox, input.path, "read");
      const bytes = await sandbox.readFile(target.absolute, ENGINEER_TOOL_LIMITS.readBytes);
      if (bytes === null) throw new Error(`${target.relative} does not exist or is not a file`);
      if (looksBinary(bytes)) throw new Error(`${target.relative} is a binary file`);
      const lines = decode(bytes).split("\n");
      const start = (input.startLine ?? 1) - 1;
      const slice = lines.slice(start, start + ENGINEER_TOOL_LIMITS.readLines);
      const numbered = slice.map((line, index) => `${start + index + 1}\t${line}`).join("\n");
      return {
        summary: `Read ${target.relative} (${slice.length} lines)`,
        forModel: numbered === "" ? "(empty file)" : numbered,
      };
    },
  });

  const listDir = defineTool({
    name: "list_dir",
    description: "List the entries of a directory in the repository (directories end with /).",
    capability: CAPABILITIES.sandboxRead,
    inputSchema: z.object({ path: z.string().max(400).default(".") }),
    targetDomain: () => undefined,
    summariseArgs: (input) => `list ${input.path}`,
    execute: async (input) => {
      const sandbox = await options.sandbox();
      const target = await confinePath(sandbox, input.path, "read");
      const result = await sandbox.exec({
        cmd: "ls",
        args: ["-1Ap", "--", target.absolute],
        timeoutMs: SHIP_TIMEOUTS.gitMs,
      });
      if (result.exitCode !== 0) throw new Error(`${target.relative || "."} is not a directory`);
      const entries = result.stdout
        .split("\n")
        .filter((entry) => entry !== "" && entry !== ".git/")
        .slice(0, ENGINEER_TOOL_LIMITS.listEntries);
      return {
        summary: `Listed ${target.relative || "."} (${entries.length} entries)`,
        forModel: entries.join("\n") || "(empty directory)",
      };
    },
  });

  const search = defineTool({
    name: "search",
    description:
      "Search the repository for a fixed string (not a regex), like ripgrep. Returns file:line:text matches, skipping .git and node_modules.",
    capability: CAPABILITIES.sandboxRead,
    inputSchema: z.object({
      pattern: z.string().min(1).max(ENGINEER_TOOL_LIMITS.searchPatternChars),
      path: z.string().max(400).default("."),
    }),
    targetDomain: () => undefined,
    summariseArgs: (input) => `search "${input.pattern}" in ${input.path}`,
    execute: async (input) => {
      const sandbox = await options.sandbox();
      const target = await confinePath(sandbox, input.path, "read");
      const result = await sandbox.exec({
        cmd: "grep",
        args: [
          "-rnIF",
          "--exclude-dir=.git",
          "--exclude-dir=node_modules",
          "--exclude-dir=.venv",
          "-m",
          "20",
          "-e",
          input.pattern,
          "--",
          target.absolute,
        ],
        timeoutMs: SHIP_TIMEOUTS.gitMs,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw new Error("The search could not run");
      const prefix = `${sandbox.repoDir}/`;
      const root = `${await sandbox.resolve(sandbox.repoDir)}/`;
      const matches = result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.replace(root, "").replace(prefix, ""))
        .slice(0, ENGINEER_TOOL_LIMITS.searchMatches);
      return {
        summary: `${matches.length} matches for "${input.pattern}"`,
        forModel: matches.join("\n") || "No matches.",
      };
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    description: `Create or overwrite a text file in the repository with the full new content (max ${Math.round(ENGINEER_TOOL_LIMITS.writeBytes / 1000)} KB). CI workflows, .git and repository configuration files cannot be written.`,
    capability: CAPABILITIES.sandboxWrite,
    inputSchema: z.object({
      path: z.string().min(1).max(400),
      content: z.string().max(ENGINEER_TOOL_LIMITS.writeBytes),
    }),
    targetDomain: () => undefined,
    summariseArgs: (input) => `write ${input.path} (${input.content.length} chars)`,
    execute: async (input) => {
      const sandbox = await options.sandbox();
      const target = await confinePath(sandbox, input.path, "write");
      const bytes = new TextEncoder().encode(input.content);
      if (bytes.byteLength > ENGINEER_TOOL_LIMITS.writeBytes)
        throw new Error("file_too_large: the content is over the size cap");
      await sandbox.writeFile(target.absolute, bytes);
      options.onWrite?.(target.relative);
      return {
        summary: `Wrote ${target.relative} (${bytes.byteLength} bytes)`,
        forModel: `Wrote ${target.relative}.`,
      };
    },
  });

  const run = defineTool({
    name: "run",
    description: `Run one of the repository's own commands in the sandbox: ${commandIds
      .map((id) => {
        const command = commands[id];
        return command === undefined ? id : `${id} (${commandLabel(command)})`;
      })
      .join(", ")}. Nothing else can be run.`,
    capability: CAPABILITIES.sandboxExec,
    inputSchema: z.object({ command: z.string().min(1).max(40) }),
    targetDomain: () => undefined,
    summariseArgs: (input) => `run ${input.command}`,
    execute: async (input, execution) => {
      const command = commands[input.command];
      if (command === undefined)
        throw new Error(
          `command_not_allowed: ${input.command.slice(0, 40)} is not one of ${commandIds.join(", ")}`,
        );
      const sandbox = await options.sandbox();
      const result = await runInSandbox(ctx, sandbox, {
        stepId: execution.stepId,
        purpose: "engineer",
        argv: command.argv,
        timeoutMs: SHIP_TIMEOUTS.toolMs,
      });
      const output = result.output.slice(-ENGINEER_TOOL_LIMITS.commandOutputChars);
      const status = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`;
      return {
        summary: `${commandLabel(command)}: ${status}`,
        forModel: `${commandLabel(command)} → ${status}\n${output}`,
      };
    },
  });

  return [readFile, listDir, search, writeFile, run];
}
