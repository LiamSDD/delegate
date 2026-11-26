import { runCli } from "./cli";
import { nodeIo } from "./node-io";

process.exitCode = await runCli(process.argv.slice(2), nodeIo());
