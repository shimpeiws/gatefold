import { analyze } from "./application/analyze.js";
import type { AnalysisResult } from "./domain/claim.js";
import { sanitizeText } from "./domain/sanitize.js";
import {
  PflExportError,
  readPflExport,
  readPflExportStdin,
} from "./input/pfl-export.js";
import { formatHuman } from "./output/human.js";
import { formatJson } from "./output/json.js";

type OutputFormat = "human" | "json";

export const EXIT_USAGE = 2;
export const EXIT_INPUT = 3;
export const EXIT_INTERNAL = 4;

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "CliError";
  }
}

interface CliOptions {
  readonly inputPath?: string;
  readonly stdin: boolean;
  readonly format: OutputFormat;
  readonly minConfidence: number;
  /** The --min-confidence token exactly as supplied, for display. */
  readonly minConfidenceText: string;
  readonly help: boolean;
}

function optionValue(
  args: readonly string[],
  index: number,
  name: string,
): [string, number] {
  const argument = args[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix))
    return [argument.slice(prefix.length), index];
  const value = args[index + 1];
  if (value === undefined)
    throw new CliError(`${name} requires a value`, EXIT_USAGE);
  return [value, index + 1];
}

function parseArgs(args: readonly string[]): CliOptions {
  let inputPath: string | undefined;
  let stdin = false;
  let format: OutputFormat = "human";
  let minConfidence = 0;
  let minConfidenceText = "0";
  let optionsDone = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!optionsDone && (argument === "--help" || argument === "-h"))
      return {
        inputPath,
        stdin,
        format,
        minConfidence,
        minConfidenceText,
        help: true,
      };
    if (!optionsDone && argument === "--") {
      optionsDone = true;
      continue;
    }
    if (
      !optionsDone &&
      (argument === "--format" || argument.startsWith("--format="))
    ) {
      const [value, consumed] = optionValue(args, index, "--format");
      index = consumed;
      if (value !== "human" && value !== "json")
        throw new CliError(
          `--format must be either human or json (got '${value}')`,
          EXIT_USAGE,
        );
      format = value;
      continue;
    }
    if (
      !optionsDone &&
      (argument === "--min-confidence" ||
        argument.startsWith("--min-confidence="))
    ) {
      const [value, consumed] = optionValue(args, index, "--min-confidence");
      index = consumed;
      if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))
        throw new CliError(
          `--min-confidence must be a decimal number between 0 and 1 (got '${value}')`,
          EXIT_USAGE,
        );
      const parsed = Number(value);
      if (parsed < 0 || parsed > 1)
        throw new CliError(
          `--min-confidence must be a number between 0 and 1 (got '${value}')`,
          EXIT_USAGE,
        );
      minConfidence = parsed;
      minConfidenceText = value;
      continue;
    }
    if (!optionsDone && argument === "-") {
      if (inputPath !== undefined)
        throw new CliError("only one input file is allowed", EXIT_USAGE);
      inputPath = argument;
      stdin = true;
      continue;
    }
    if (!optionsDone && argument.startsWith("-"))
      throw new CliError(
        `unknown option: ${argument} (see --help)`,
        EXIT_USAGE,
      );
    if (inputPath !== undefined)
      throw new CliError("only one input file is allowed", EXIT_USAGE);
    inputPath = argument;
  }
  return {
    inputPath,
    stdin,
    format,
    minConfidence,
    minConfidenceText,
    help: false,
  };
}

function usage(): string {
  return [
    "Usage: gatefold <input.json> [options]",
    "       gatefold -               Read the export from standard input",
    "",
    "Analyze a pfl export and print evidence-backed claims.",
    "Pass '-' as the input to read a pfl export piped on stdin,",
    "e.g. `pfl report --json | gatefold -`. After '--', '-' names a file.",
    "",
    "Options:",
    "  --format <human|json>        Output format (default: human)",
    "  --min-confidence <0..1>      Only print claims at or above this confidence (default: 0)",
    "  -h, --help                   Show this help",
    "  --                           Stop option parsing (paths starting with '-')",
    "",
    "Exit codes: 0 success, 2 usage error, 3 input error, 4 internal error",
  ].join("\n");
}

export function filterClaims(
  result: AnalysisResult,
  minConfidence: number,
): AnalysisResult {
  if (minConfidence <= 0) return result;
  return {
    ...result,
    claims: result.claims.filter((claim) => claim.confidence >= minConfidence),
  };
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof PflExportError) return EXIT_INPUT;
  return EXIT_INTERNAL;
}

export async function runCli(args: readonly string[]): Promise<string> {
  const options = parseArgs(args);
  if (options.help) return usage();
  if (options.inputPath === undefined)
    throw new CliError(
      "an input JSON file or '-' for stdin is required (see --help)",
      EXIT_USAGE,
    );
  const result = analyze(
    options.stdin
      ? await readPflExportStdin()
      : await readPflExport(options.inputPath),
  );
  const filtered = filterClaims(result, options.minConfidence);
  return options.format === "json"
    ? formatJson(filtered)
    : formatHuman(filtered, options.minConfidence, options.minConfidenceText);
}

export async function main(args: readonly string[]): Promise<number> {
  try {
    process.stdout.write(`${await runCli(args)}\n`);
    process.exitCode = 0;
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`gatefold: ${sanitizeText(message)}\n`);
    const code = exitCodeForError(error);
    process.exitCode = code;
    return code;
  }
}
