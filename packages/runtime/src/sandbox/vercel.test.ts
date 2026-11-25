import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  create: [] as unknown[],
  run: [] as unknown[],
  update: [] as unknown[],
  failCreate: false,
}));

vi.mock("@vercel/sandbox", () => {
  const handle = {
    name: "sbx_test",
    runCommand: (params: unknown) => {
      calls.run.push(params);
      return Promise.resolve({
        exitCode: 0,
        durationMs: 12,
        stdout: () => Promise.resolve("/vercel/sandbox/repo/src\n"),
        stderr: () => Promise.resolve(""),
      });
    },
    update: (params: unknown) => {
      calls.update.push(params);
      return Promise.resolve();
    },
    extendTimeout: () => Promise.resolve(),
    stop: () => Promise.resolve({}),
    mkDir: () => Promise.resolve(),
    writeFiles: () => Promise.resolve(),
    readFileToBuffer: () => Promise.resolve(Buffer.from("content")),
  };
  return {
    Sandbox: {
      create: (params: unknown) => {
        calls.create.push(params);
        return calls.failCreate
          ? Promise.reject(new Error("401 token eyJabc.eyJdef.sig is invalid"))
          : Promise.resolve(handle);
      },
      get: () => Promise.resolve(handle),
    },
  };
});

const { NETWORK_POLICIES, SandboxUnavailableError, createVercelSandboxProvider } =
  await import("./index");

beforeEach(() => {
  calls.create.length = 0;
  calls.run.length = 0;
  calls.update.length = 0;
  calls.failCreate = false;
});

describe("VercelSandbox", () => {
  it("creates a non-persistent sandbox with the setup network policy and no env secrets", async () => {
    const sandbox = await createVercelSandboxProvider().create();
    expect(sandbox.id).toBe("sbx_test");
    expect(calls.create[0]).toMatchObject({
      persistent: false,
      networkPolicy: NETWORK_POLICIES.setup,
    });
    expect(calls.create[0]).not.toHaveProperty("env");
    expect(calls.create[0]).not.toHaveProperty("source");
  });

  it("runs argv commands in the repository with a per-command timeout", async () => {
    const sandbox = await createVercelSandboxProvider().create();
    const result = await sandbox.exec({ cmd: "npm", args: ["test"], timeoutMs: 60_000 });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, durationMs: 12 });
    expect(calls.run[0]).toMatchObject({
      cmd: "npm",
      args: ["test"],
      cwd: "/vercel/sandbox/repo",
      timeoutMs: 60_000,
    });
    expect(JSON.stringify(calls.run[0])).not.toMatch(/TOKEN|KEY|SECRET/);
    expect(await sandbox.resolve("/vercel/sandbox/repo/src")).toBe("/vercel/sandbox/repo/src");
  });

  it("locks the network down to package registries for the work phase", async () => {
    const sandbox = await createVercelSandboxProvider().create();
    await sandbox.setNetwork("work");
    expect(calls.update).toEqual([{ networkPolicy: NETWORK_POLICIES.work }]);
  });

  it("fails honestly, without leaking credentials, when the service is unavailable", async () => {
    calls.failCreate = true;
    const error: unknown = await createVercelSandboxProvider()
      .create()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxUnavailableError);
    expect((error as Error).message).toContain("Vercel Sandbox is unavailable");
    expect((error as Error).message).not.toContain("eyJ");
  });
});
