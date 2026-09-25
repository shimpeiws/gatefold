import { analyze } from "./application/analyze.js";
import { readPflExport } from "./input/pfl-export.js";
import { formatHuman } from "./output/human.js";
import { formatJson } from "./output/json.js";

type OutputFormat = "human" | "json";

interface CliOptions {
  readonly inputPath?: string;
  readonly format: OutputFormat;
  readonly help: boolean;
}

function parseArgs(args: readonly string[]): CliOptions {
  let inputPath: string | undefined;
  let format: OutputFormat = "human";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h")
      return { inputPath, format, help: true };
    if (argument === "--format" || argument.startsWith("--format=")) {
      const value =
        argument === "--format"
          ? args[++index]
          : argument.slice("--format=".length);
      if (value !== "human" && value !== "json")
        throw new Error("--format must be either human or json");
      format = value;
      continue;
    }
    if (argument.startsWith("-"))
      throw new Error(`unknown option: ${argument}`);
    if (inputPath !== undefined)
      throw new Error("only one input file is allowed");
    inputPath = argument;
  }
  return { inputPath, format, help: false };
}

function usage(): string {
  return [
    "Usage: gatefold <input.json> [--format human|json]",
    "",
    "Analyze a pfl export and print evidence-backed claims.",
  ].join("\n");
}

export async function runCli(args: readonly string[]): Promise<string> {
  const options = parseArgs(args);
  if (options.help) return usage();
  if (options.inputPath === undefined)
    throw new Error("an input JSON file is required");
  const result = analyze(await readPflExport(options.inputPath));
  return options.format === "json" ? formatJson(result) : formatHuman(result);
}

export async function main(args: readonly string[]): Promise<void> {
  try {
    process.stdout.write(`${await runCli(args)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`gatefold: ${message}\n`);
    process.exitCode = 1;
  }
}
