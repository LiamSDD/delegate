import { CAPABILITIES } from "@delegate/policy";
import { z } from "zod";

import { FetchBlockedError, type Fetcher } from "../../tools/fetch";
import { defineTool, type RegisteredTool } from "../../tools/registry";
import { snapshotFromTarball, SNAPSHOT_LIMITS, type RepoSnapshot } from "./snapshot";
import { TarballError } from "./tarball";

export const REPO_ARCHIVE_HOST = "codeload.github.com";
export const DOWNLOAD_REPO_TOOL = "download_repo";
export const ARCHIVE_TIMEOUT_MS = 60_000;

const ArchiveInputSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/),
  repo: z.string().regex(/^[\w.-]{1,100}$/),
  ref: z.string().regex(/^(?!.*\.\.)(?!\/)[\w./-]{1,200}$/),
});

export function archiveUrl(owner: string, repo: string, ref: string): string {
  const path = [owner, repo, "tar.gz", ...ref.split("/")].map(encodeURIComponent).join("/");
  return `https://${REPO_ARCHIVE_HOST}/${path}`;
}

function describeBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function downloadFailure(error: unknown): string {
  if (error instanceof FetchBlockedError) {
    if (error.code === "http_error" && error.status === 404)
      return "The repository or ref was not found. Only public GitHub repositories can be analysed.";
    if (error.code === "http_error" && (error.status === 403 || error.status === 429))
      return "GitHub is rate-limiting archive downloads right now; try again in a few minutes.";
    if (error.code === "too_large")
      return `The repository archive is larger than the ${describeBytes(SNAPSHOT_LIMITS.maxCompressedBytes)} cap.`;
    return `The archive download failed (${error.code}): ${error.message}`;
  }
  if (error instanceof TarballError) return `The archive could not be read: ${error.message}`;
  return error instanceof Error ? error.message : "The archive download failed";
}

export function repoArchiveTool(options: {
  fetcher: Fetcher;
  onSnapshot: (snapshot: RepoSnapshot) => void;
  signal?: AbortSignal;
}): RegisteredTool {
  return defineTool({
    name: DOWNLOAD_REPO_TOOL,
    description:
      "Download one public GitHub repository as a single tar.gz archive from codeload.github.com and read it into a capped, text-only snapshot.",
    capability: CAPABILITIES.webFetch,
    inputSchema: ArchiveInputSchema,
    targetDomain: () => REPO_ARCHIVE_HOST,
    summariseArgs: (input) => `GET ${archiveUrl(input.owner, input.repo, input.ref)}`,
    execute: async (input) => {
      let snapshot: RepoSnapshot;
      let compressed: number;
      try {
        const file = await options.fetcher.download({
          url: archiveUrl(input.owner, input.repo, input.ref),
          accept: "application/x-gzip, application/gzip",
          contentTypes: [/^application\/(x-)?gzip$/, /^application\/octet-stream$/],
          maxBytes: SNAPSHOT_LIMITS.maxCompressedBytes,
          timeoutMs: ARCHIVE_TIMEOUT_MS,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        compressed = file.bytes.byteLength;
        snapshot = await snapshotFromTarball(file.bytes, input);
      } catch (error) {
        throw new Error(downloadFailure(error), { cause: error });
      }
      options.onSnapshot(snapshot);
      const summary = `${describeBytes(compressed)} archive: kept ${snapshot.files.size} text files, skipped ${snapshot.skipped.length}${snapshot.truncated === false ? "" : ` (stopped at the ${snapshot.truncated.replace("_", " ")})`}`;
      return { summary, forModel: summary };
    },
  });
}
