export const packageName = "@delegate/cli" as const;

export { CLI_USER_AGENT, CLI_VERSION, describeFailure, HELP, runCli } from "./cli";
export {
  CONFIG_ENV,
  configPath,
  DEFAULT_BASE_URL,
  readConfig,
  resolveCredentials,
  TOKEN_ENV,
  URL_ENV,
  writeConfig,
} from "./config";
export { CliError, EXIT, EXIT_MEANINGS, type ExitCode } from "./exit-codes";
export { type CliFiles, type CliIo, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./io";
export { nodeFiles, nodeIo } from "./node-io";
export { plain, renderEvent, renderOutcome, renderRun, renderRunList } from "./render";
