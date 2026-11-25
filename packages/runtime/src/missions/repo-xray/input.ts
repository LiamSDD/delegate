import { z } from "zod";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[\w.-]{1,100}$/;
const REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[\w./-]{1,200}$/;
const RESERVED_OWNERS = new Set([
  "about",
  "apps",
  "collections",
  "enterprise",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending",
]);

export interface GithubRepoRef {
  owner: string;
  repo: string;
  ref: string | undefined;
}

export function parseGithubRepoUrl(raw: string): GithubRepoRef | null {
  const text = raw.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const [owner, rawRepo, marker, ...rest] = segments;
  if (owner === undefined || rawRepo === undefined) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (!REPO.test(repo) || repo === "." || repo === "..") return null;
  const ref = marker === "tree" && rest.length > 0 ? decodeURIComponent(rest.join("/")) : undefined;
  if (ref !== undefined && !REF.test(ref)) return null;
  return { owner, repo, ref };
}

export const RepoXrayInputSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    ref: z.string().trim().regex(REF, "Not a valid git ref").optional(),
  })
  .transform((input, ctx) => {
    const parsed = parseGithubRepoUrl(input.url);
    if (parsed === null) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Expected a public GitHub repository URL such as github.com/owner/repo",
      });
      return z.NEVER;
    }
    const ref = input.ref ?? parsed.ref;
    return {
      url: `https://github.com/${parsed.owner}/${parsed.repo}`,
      owner: parsed.owner,
      repo: parsed.repo,
      ...(ref === undefined ? {} : { ref }),
    };
  });

export type RepoXrayInput = z.infer<typeof RepoXrayInputSchema>;
