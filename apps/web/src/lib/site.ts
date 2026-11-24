import packageJson from "../../package.json";

export const REPO_URL = "https://github.com/LiamSDD/delegate";
export const APP_VERSION: string = packageJson.version;

export function repoFileUrl(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}

export const DOCS_URL = `${REPO_URL}/tree/main/docs`;

export const NAV_ITEMS = [
  { href: "/runs", label: "Runs" },
  { href: "/control", label: "Control" },
  { href: "/evals", label: "Evals" },
  { href: "/docs", label: "Docs" },
] as const;
