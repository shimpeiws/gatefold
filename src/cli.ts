import { analyze } from "./application/analyze.js";
import { compareDocuments } from "./application/compare.js";
import { compareRuns } from "./application/compare-runs.js";
import { compareTraces } from "./application/compare-traces.js";
import type { ComparisonResult } from "./domain/comparison.js";
import type { RunComparisonResult } from "./domain/run-comparison.js";
import { sanitizeText } from "./domain/sanitize.js";
import type { TraceComparisonResult } from "./domain/trace-comparison.js";
import {
  PflExportError,
  readPflExport,
  readPflExportStdin,
  STDIN_SOURCE,
} from "./input/pfl-export.js";
import { readYuureiRun } from "./input/yuurei-run.js";
import { readYuureiTrace, readYuureiTraceStdin } from "./input/yuurei-trace.js";
import {
  formatComparisonHuman,
  formatHuman,
  formatRunComparisonHuman,
  formatTraceComparisonHuman,
} from "./output/human.js";
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
  readonly compare?: {
    before?: string;
    after?: string;
    diff?: string;
  };
  readonly compareTraces?: {
    before?: string;
    after?: string;
  };
  readonly compareRuns?: {
    before?: string;
    after?: string;
  };
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
  let compare: CliOptions["compare"];
  let compareTraces: CliOptions["compareTraces"];
  let compareRuns: CliOptions["compareRuns"];
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
      (compare !== undefined ||
        compareTraces !== undefined ||
        compareRuns !== undefined) &&
      (argument === "--before" ||
        argument.startsWith("--before=") ||
        argument === "--after" ||
        argument.startsWith("--after=") ||
        (compare !== undefined &&
          (argument === "--diff" || argument.startsWith("--diff="))))
    ) {
      const name = argument.slice(
        2,
        argument.indexOf("=") === -1 ? undefined : argument.indexOf("="),
      );
      const [value, consumed] = optionValue(args, index, `--${name}`);
      index = consumed;
      const target = compare ?? compareTraces ?? compareRuns;
      if ((target as Record<string, unknown>)[name] !== undefined)
        throw new CliError(`--${name} is already set`, EXIT_USAGE);
      if (compare !== undefined) compare = { ...compare, [name]: value };
      else if (compareTraces !== undefined)
        compareTraces = { ...compareTraces, [name]: value };
      else compareRuns = { ...compareRuns, [name]: value };
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
      if (compare !== undefined)
        throw new CliError(
          "compare inputs must be given with --before/--after/--diff; '-' is a flag value, not a positional",
          EXIT_USAGE,
        );
      if (compareTraces !== undefined)
        throw new CliError(
          "compare-traces inputs must be given with --before/--after; '-' is a flag value, not a positional",
          EXIT_USAGE,
        );
      if (compareRuns !== undefined)
        throw new CliError(
          "compare-runs inputs must be given with --before/--after; '-' is a flag value, not a positional",
          EXIT_USAGE,
        );
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
    if (
      !optionsDone &&
      compare === undefined &&
      compareTraces === undefined &&
      compareRuns === undefined &&
      inputPath === undefined &&
      (argument === "compare" ||
        argument === "compare-traces" ||
        argument === "compare-runs")
    ) {
      if (argument === "compare") compare = {};
      else if (argument === "compare-traces") compareTraces = {};
      else compareRuns = {};
      continue;
    }
    if (compare !== undefined)
      throw new CliError(
        "compare takes no positional inputs; use --before/--after/--diff",
        EXIT_USAGE,
      );
    if (compareTraces !== undefined)
      throw new CliError(
        "compare-traces takes no positional inputs; use --before/--after",
        EXIT_USAGE,
      );
    if (compareRuns !== undefined)
      throw new CliError(
        "compare-runs takes no positional inputs; use --before/--after",
        EXIT_USAGE,
      );
    if (inputPath !== undefined)
      throw new CliError("only one input file is allowed", EXIT_USAGE);
    inputPath = argument;
  }
  if (compare !== undefined) {
    const missing = (["before", "after", "diff"] as const).filter(
      (flag) => compare[flag] === undefined,
    );
    if (missing.length > 0)
      throw new CliError(
        `compare requires ${missing.map((f) => `--${f}`).join(", ")} (see --help)`,
        EXIT_USAGE,
      );
    const stdinCount = [compare.before, compare.after, compare.diff].filter(
      (value) => value === "-",
    ).length;
    if (stdinCount > 1)
      throw new CliError(
        "at most one of --before/--after/--diff may read from stdin ('-')",
        EXIT_USAGE,
      );
  }
  if (compareTraces !== undefined) {
    const missing = (["before", "after"] as const).filter(
      (flag) => compareTraces[flag] === undefined,
    );
    if (missing.length > 0)
      throw new CliError(
        `compare-traces requires ${missing.map((f) => `--${f}`).join(", ")} (see --help)`,
        EXIT_USAGE,
      );
    const stdinCount = [compareTraces.before, compareTraces.after].filter(
      (value) => value === "-",
    ).length;
    if (stdinCount > 1)
      throw new CliError(
        "at most one of --before/--after may read from stdin ('-')",
        EXIT_USAGE,
      );
  }
  if (compareRuns !== undefined) {
    const missing = (["before", "after"] as const).filter(
      (flag) => compareRuns[flag] === undefined,
    );
    if (missing.length > 0)
      throw new CliError(
        `compare-runs requires ${missing.map((f) => `--${f}`).join(", ")} (see --help)`,
        EXIT_USAGE,
      );
    if (compareRuns.before === "-" || compareRuns.after === "-")
      throw new CliError(
        "compare-runs reads run directories; '-' for stdin is not supported",
        EXIT_USAGE,
      );
  }
  return {
    inputPath,
    stdin,
    compare,
    compareTraces,
    compareRuns,
    format,
    minConfidence,
    minConfidenceText,
    help: false,
  };
}

function usage(): string {
  return [
    "Usage: gatefold <input.json> [options]",
    "       gatefold -               Read a pfl document from standard input",
    "       gatefold compare --before <A.json|-> --after <B.json|-> --diff <D.json|->",
    "                              Compare two pfl exports through their diff",
    "       gatefold compare-traces --before <A.trace.json|-> --after <B.trace.json|->",
    "                              Compare two yuurei runs through their traces",
    "       gatefold compare-runs --before <A-run-dir> --after <B-run-dir>",
    "                              Compare two yuurei run directories, artifacts included",
    "",
    "Analyze a pfl report, export, or diff and print evidence-backed claims.",
    "The document's top-level 'command' field selects the reader.",
    "Pass '-' as the input to read a pfl document piped on stdin,",
    "e.g. `pfl report --json | gatefold -` (likewise `export` and `diff`).",
    "After '--', '-' names a file.",
    "",
    "compare reads three documents: A's export (--before), B's export",
    "(--after), and the A → B diff (--diff). At most one of the three may",
    "be '-' for stdin. The exports must describe the same project and",
    "runtime and must bind to the diff's A and B snapshot sides.",
    "",
    "compare-traces reads two yuurei trace.json documents: run A",
    "(--before) and run B (--after). At most one of the two may be '-'",
    "for stdin. The runs are compared only when the requested task and",
    "execution conditions match; the profile/harness variant may differ",
    "intentionally. A pfl document passed as a trace input is rejected.",
    "",
    "compare-runs reads two yuurei run directories: run A (--before) and",
    "run B (--after). Each must contain trace.json and artifacts.json; a",
    "patch.diff listed in the manifest is verified against its recorded",
    "digest before its generated-file content is compared. Directories",
    "cannot be read from stdin; '-' is rejected.",
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

export function filterClaims<
  T extends {
    readonly claims: readonly { readonly confidence: number }[];
  },
>(result: T, minConfidence: number): T {
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

async function readCompareInput(argument: string) {
  return argument === "-" ? readPflExportStdin() : readPflExport(argument);
}

async function readTraceInput(argument: string) {
  return argument === "-" ? readYuureiTraceStdin() : readYuureiTrace(argument);
}

export async function runCli(args: readonly string[]): Promise<string> {
  const options = parseArgs(args);
  if (options.help) return usage();
  if (options.compareRuns !== undefined) {
    const compareRunsArgs = options.compareRuns as {
      before: string;
      after: string;
    };
    const result: RunComparisonResult = compareRuns({
      before: await readYuureiRun(compareRunsArgs.before),
      after: await readYuureiRun(compareRunsArgs.after),
      labels: {
        before: compareRunsArgs.before,
        after: compareRunsArgs.after,
      },
    });
    const filtered = filterClaims(result, options.minConfidence);
    return options.format === "json"
      ? formatJson(filtered)
      : formatRunComparisonHuman(
          filtered,
          options.minConfidence,
          options.minConfidenceText,
        );
  }
  if (options.compareTraces !== undefined) {
    const compareTracesArgs = options.compareTraces as {
      before: string;
      after: string;
    };
    const result: TraceComparisonResult = compareTraces({
      before: await readTraceInput(compareTracesArgs.before),
      after: await readTraceInput(compareTracesArgs.after),
      labels: {
        before:
          compareTracesArgs.before === "-"
            ? STDIN_SOURCE
            : compareTracesArgs.before,
        after:
          compareTracesArgs.after === "-"
            ? STDIN_SOURCE
            : compareTracesArgs.after,
      },
    });
    const filtered = filterClaims(result, options.minConfidence);
    return options.format === "json"
      ? formatJson(filtered)
      : formatTraceComparisonHuman(
          filtered,
          options.minConfidence,
          options.minConfidenceText,
        );
  }
  if (options.compare !== undefined) {
    const compare = options.compare as {
      before: string;
      after: string;
      diff: string;
    };
    const result: ComparisonResult = compareDocuments({
      before: await readCompareInput(compare.before),
      after: await readCompareInput(compare.after),
      diff: await readCompareInput(compare.diff),
      labels: {
        before: compare.before === "-" ? STDIN_SOURCE : compare.before,
        after: compare.after === "-" ? STDIN_SOURCE : compare.after,
        diff: compare.diff === "-" ? STDIN_SOURCE : compare.diff,
      },
    });
    const filtered = filterClaims(result, options.minConfidence);
    return options.format === "json"
      ? formatJson(filtered)
      : formatComparisonHuman(
          filtered,
          options.minConfidence,
          options.minConfidenceText,
        );
  }
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
