import path from "node:path";

import { z } from "zod";

import { CliError, EXIT } from "./exit-codes";
import { type CliIo, PRIVATE_FILE_MODE } from "./io";

export const DEFAULT_BASE_URL = "http://localhost:3000";
export const TOKEN_PATTERN = /^dlg_[A-Za-z0-9_-]{16,200}$/;
export const TOKEN_ENV = "DELEGATE_TOKEN";
export const URL_ENV = "DELEGATE_URL";
export const CONFIG_ENV = "DELEGATE_CONFIG";

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  baseUrl: z.url(),
  token: z.string().regex(TOKEN_PATTERN),
});
export type CliConfig = z.infer<typeof ConfigSchema>;

export function configPath(io: Pick<CliIo, "env" | "homeDir">): string {
  const explicit = io.env[CONFIG_ENV]?.trim();
  if (explicit !== undefined && explicit !== "") return path.resolve(explicit);
  const xdg = io.env.XDG_CONFIG_HOME?.trim();
  const base = xdg !== undefined && xdg !== "" ? xdg : path.join(io.homeDir, ".config");
  return path.join(base, "delegate", "config.json");
}

export function normaliseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CliError(EXIT.usage, `"${raw}" is not a URL.`, "Example: https://delegate.example");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new CliError(
      EXIT.usage,
      "The Delegate URL must use https (http is allowed for localhost only).",
    );
  if (url.username !== "" || url.password !== "")
    throw new CliError(EXIT.usage, "The Delegate URL must not contain credentials.");
  return url.origin;
}

export async function readConfig(io: Pick<CliIo, "env" | "homeDir" | "files" | "platform">) {
  const file = configPath(io);
  const text = await io.files.read(file);
  if (text === null) return { file, config: null, warning: null };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success)
    throw new CliError(
      EXIT.auth,
      `${file} is not a valid Delegate config file.`,
      "Run `delegate login` to write a new one.",
    );
  const mode = io.platform === "win32" ? null : await io.files.mode(file);
  const warning =
    mode !== null && (mode & 0o077) !== 0
      ? `warning: ${file} is readable by other users (mode ${mode.toString(8).padStart(3, "0")}); run: chmod 600 ${file}`
      : null;
  return { file, config: parsed.data, warning };
}

export async function writeConfig(
  io: Pick<CliIo, "env" | "homeDir" | "files">,
  config: Omit<CliConfig, "version">,
): Promise<string> {
  const file = configPath(io);
  const content = ConfigSchema.parse({ version: 1, ...config });
  await io.files.writePrivate(file, `${JSON.stringify(content, null, 2)}\n`);
  return file;
}

export interface Credentials {
  baseUrl: string;
  token: string;
  source: "environment" | "config";
}

export const NOT_LOGGED_IN_HINT = `Run \`delegate login\`, or set ${TOKEN_ENV} (create a token in the web app under Settings, Connections).`;

export async function resolveCredentials(
  io: Pick<CliIo, "env" | "homeDir" | "files" | "platform" | "stderr">,
  urlFlag: string | undefined,
): Promise<Credentials> {
  const envToken = io.env[TOKEN_ENV]?.trim();
  const envUrl = io.env[URL_ENV]?.trim();
  const requested = urlFlag ?? (envUrl === undefined || envUrl === "" ? undefined : envUrl);
  if (envToken !== undefined && envToken !== "") {
    if (!TOKEN_PATTERN.test(envToken))
      throw new CliError(
        EXIT.auth,
        `${TOKEN_ENV} is not a Delegate API token (they start with dlg_).`,
      );
    const stored = requested === undefined ? (await readConfig(io)).config : null;
    return {
      baseUrl: normaliseBaseUrl(requested ?? stored?.baseUrl ?? DEFAULT_BASE_URL),
      token: envToken,
      source: "environment",
    };
  }
  const { config, warning, file } = await readConfig(io);
  if (config === null) throw new CliError(EXIT.auth, "Not logged in.", NOT_LOGGED_IN_HINT);
  if (warning !== null) io.stderr(`${warning}\n`);
  const baseUrl = normaliseBaseUrl(requested ?? config.baseUrl);
  if (baseUrl !== normaliseBaseUrl(config.baseUrl))
    throw new CliError(
      EXIT.auth,
      `The token in ${file} belongs to ${config.baseUrl}; it is not sent to ${baseUrl}.`,
      `Run \`delegate login --url ${baseUrl}\`, or set ${TOKEN_ENV} for that deployment.`,
    );
  return { baseUrl, token: config.token, source: "config" };
}

export { PRIVATE_FILE_MODE };
