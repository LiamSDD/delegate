export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  refused: 5,
  rateLimited: 6,
  unavailable: 7,
  runFailed: 10,
  runCancelled: 11,
  timedOut: 12,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_MEANINGS: Record<keyof typeof EXIT, string> = {
  ok: "The command succeeded; with --watch, the run completed.",
  error: "An unexpected error in the CLI.",
  usage: "Unknown command or bad arguments.",
  auth: "No token, or the token was refused (401, 403).",
  notFound: "The run, artifact or assistant does not exist for this token (404).",
  refused: "The API refused the request: validation, a conflict, a finished run (other 4xx).",
  rateLimited: "A request or run quota is used up (429).",
  unavailable: "Delegate could not be reached or failed (network error, 5xx, bad response).",
  runFailed: "With --watch: the run failed.",
  runCancelled: "With --watch: the run was cancelled.",
  timedOut: "With --watch: --timeout elapsed first; the run is still going.",
  interrupted: "Interrupted with Ctrl-C; a started run keeps going.",
};

export class CliError extends Error {
  override readonly name = "CliError";
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export function usage(message: string, hint?: string): CliError {
  return new CliError(EXIT.usage, message, hint);
}
