export interface RepoRef {
  owner: string;
  name: string;
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

export function repoFullName(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function parseGitHubRepoUrl(raw: string): RepoRef | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  const parts = url.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (owner === undefined || name === undefined || !NAME.test(owner) || !NAME.test(name))
    return null;
  if (name === "." || name === "..") return null;
  return { owner, name };
}
