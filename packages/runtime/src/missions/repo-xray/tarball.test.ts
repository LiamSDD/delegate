import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { repoTarGz, tarEntries } from "../../testing/tarball";
import { snapshotFromTarball, skipReasonFor, SNAPSHOT_LIMITS } from "./snapshot";
import { normaliseEntryPath, readTarGz, TarballError } from "./tarball";

const keepAll = () => ({ keep: true as const });
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const coordinates = { owner: "acme", repo: "widget", ref: "HEAD" };

describe("readTarGz", () => {
  it("reads files, directories, pax paths, GNU long names and the global commit header", async () => {
    const longPath = `widget-main/${"deep/".repeat(25)}file.ts`;
    const archive = gzipSync(
      tarEntries([
        { path: COMMIT, type: "pax-global" },
        { path: "widget-main/", type: "directory" },
        { path: "widget-main/a.txt", content: "alpha\n" },
        { path: longPath, type: "pax-path", content: "export const x = 1;\n" },
        { path: `widget-main/${"long/".repeat(22)}gnu.ts`, type: "gnu-longname", content: "g" },
        { path: "widget-main/link", type: "symlink", linkTarget: "a.txt" },
      ]),
    );
    const seen: string[] = [];
    const result = await readTarGz(archive, {
      decide: (entry) => {
        seen.push(`${entry.type}:${entry.path}`);
        return entry.type === "file" ? { keep: true } : { keep: false, reason: "not_regular_file" };
      },
    });
    expect(result.globalHeaders.comment).toBe(COMMIT);
    expect(result.files.map((file) => file.path)).toEqual([
      "widget-main/a.txt",
      longPath,
      `widget-main/${"long/".repeat(22)}gnu.ts`,
    ]);
    expect(new TextDecoder().decode(result.files[0]?.bytes)).toBe("alpha\n");
    expect(new TextDecoder().decode(result.files[1]?.bytes)).toBe("export const x = 1;\n");
    expect(seen).toContain("symlink:widget-main/link");
    expect(result.skipped).toEqual([
      { path: "widget-main/link", reason: "not_regular_file", size: 0 },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("does not buffer the body of a skipped file", async () => {
    const big = "x".repeat(300_000);
    const archive = gzipSync(
      tarEntries([
        { path: "r/big.txt", content: big },
        { path: "r/s.txt", content: "s" },
      ]),
    );
    const result = await readTarGz(archive, {
      decide: (entry) =>
        entry.size > 1000 ? { keep: false, reason: "too_large" } : { keep: true },
    });
    expect(result.files.map((file) => file.path)).toEqual(["r/s.txt"]);
    expect(result.skipped).toEqual([{ path: "r/big.txt", reason: "too_large", size: 300_000 }]);
  });

  it("stops at the uncompressed byte cap and says so", async () => {
    const archive = gzipSync(
      tarEntries(
        Array.from({ length: 40 }, (_, index) => ({
          path: `r/f${index}.txt`,
          content: "y".repeat(10_000),
        })),
      ),
    );
    const result = await readTarGz(archive, { decide: keepAll, maxUncompressedBytes: 100_000 });
    expect(result.truncated).toBe("uncompressed_cap");
    expect(result.files.length).toBeLessThan(40);
    expect(result.uncompressedBytes).toBeLessThanOrEqual(100_000);
  });

  it("stops at the entry cap", async () => {
    const archive = gzipSync(
      tarEntries(Array.from({ length: 10 }, (_, index) => ({ path: `r/${index}`, content: "z" }))),
    );
    const result = await readTarGz(archive, { decide: keepAll, maxEntries: 3 });
    expect(result.truncated).toBe("entry_cap");
    expect(result.files).toHaveLength(3);
  });

  it("rejects data that is not gzip, and tar headers with a bad checksum", async () => {
    await expect(
      readTarGz(new TextEncoder().encode("not gzip"), { decide: keepAll }),
    ).rejects.toThrow(TarballError);
    const tar = tarEntries([{ path: "r/a", content: "a" }]);
    tar[150] = 0x37;
    await expect(readTarGz(gzipSync(tar), { decide: keepAll })).rejects.toMatchObject({
      code: "corrupt_tar",
    });
  });

  it("refuses pax and GNU long-name metadata bodies over 1 MB", async () => {
    const huge = `r/${"p".repeat(1_100_000)}`;
    for (const type of ["pax-path", "gnu-longname"] as const) {
      await expect(
        readTarGz(gzipSync(tarEntries([{ path: huge, type, content: "x" }])), {
          decide: keepAll,
        }),
      ).rejects.toMatchObject({ code: "corrupt_tar" });
    }
  });

  it("normalises entry paths and refuses traversal", () => {
    expect(normaliseEntryPath("widget-abc/src/./a.ts", 1)).toBe("src/a.ts");
    expect(normaliseEntryPath("widget-abc/", 1)).toBe("");
    expect(normaliseEntryPath("widget-abc/../../etc/passwd", 1)).toBeNull();
    expect(normaliseEntryPath("/etc/passwd", 0)).toBeNull();
  });
});

describe("skip rules", () => {
  it.each([
    ["node_modules/left-pad/index.js", "vendored"],
    ["packages/a/vendor/lib.go", "vendored"],
    [".git/config", "vendored"],
    ["dist/index.js", "build_output"],
    ["packages/web/.next/server.js", "build_output"],
    ["package-lock.json", "lockfile"],
    ["sub/poetry.lock", "lockfile"],
    ["docs/logo.png", "binary"],
    ["fonts/a.woff2", "binary"],
    ["static/app.min.js", "generated"],
    ["src/app.js.map", "generated"],
  ])("skips %s as %s", (path, reason) => {
    expect(skipReasonFor(path, 10)).toBe(reason);
  });

  it("keeps source files and skips oversize ones", () => {
    expect(skipReasonFor("src/index.ts", 10)).toBeNull();
    expect(skipReasonFor("README.md", 10)).toBeNull();
    expect(skipReasonFor("src/huge.ts", SNAPSHOT_LIMITS.maxFileBytes + 1)).toBe("too_large");
  });
});

describe("snapshotFromTarball", () => {
  it("strips the archive root, keeps text, records every skip with its reason and the commit", async () => {
    const archive = repoTarGz(
      "widget-0123456",
      {
        "README.md": "# Widget\n",
        "src/index.ts": "export const a = 1;\r\nexport const b = 2;\n",
        "package-lock.json": "{}",
        "node_modules/x/index.js": "module.exports = 1",
        "assets/logo.svg": "<svg/>",
        "assets/blob.dat": new Uint8Array([1, 0, 2, 3]),
        "bad.txt": new Uint8Array([0xff, 0xfe, 0x41]),
      },
      COMMIT,
    );
    const snapshot = await snapshotFromTarball(archive, coordinates);
    expect(snapshot.commit).toBe(COMMIT);
    expect([...snapshot.files.keys()].sort()).toEqual([
      "README.md",
      "assets/logo.svg",
      "src/index.ts",
    ]);
    expect(snapshot.files.get("src/index.ts")?.lineCount).toBe(2);
    expect(snapshot.lockfiles).toEqual(["package-lock.json"]);
    expect(snapshot.skipped.map((skip) => [skip.path, skip.reason]).sort()).toEqual([
      ["assets/blob.dat", "binary"],
      ["bad.txt", "binary"],
      ["node_modules/x/index.js", "vendored"],
      ["package-lock.json", "lockfile"],
    ]);
    expect(snapshot.compressedBytes).toBe(archive.length);
  });

  it("redacts secret-looking values and records only their kind and line", async () => {
    const key = ["AKIA", "Q7ZBXH2M4KTN6WRE"].join("");
    const token = ["ghp", "_", "a".repeat(20), "B1c2D3e4F5g6H7i8J9k0"].join("");
    const archive = repoTarGz("r-1", {
      "config.js": `const region = "eu";\nconst awsKey = "${key}";\nconst api_token = "${token}";\n`,
    });
    const snapshot = await snapshotFromTarball(archive, coordinates);
    const text = snapshot.files.get("config.js")?.text ?? "";
    expect(text).not.toContain(key);
    expect(text).not.toContain(token);
    expect(text).toContain("[redacted:secret]");
    expect(snapshot.secrets).toEqual([
      { kind: "aws-access-key", path: "config.js", line: 2, confidence: "high" },
      { kind: "github-token", path: "config.js", line: 3, confidence: "high" },
    ]);
  });
});
