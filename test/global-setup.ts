import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

// Build dist/ exactly once per test run. bin/gatefold.js executes dist/,
// and the pack-based tests pack it; a per-file build (or npm pack's
// prepack) rewrites dist/ while other files' CLI subprocesses read it,
// which produced torn packed artifacts in CI (missing exports mid-build).
// The suite's `npm pack` calls therefore pass --ignore-scripts and rely
// on this single build.
export default async function setup(): Promise<void> {
  const pm = process.env.npm_execpath ?? "pnpm";
  const isScript = pm.endsWith(".js") || pm.endsWith(".cjs");
  await execFileAsync(
    isScript ? process.execPath : pm,
    [...(isScript ? [pm] : []), "build"],
    { cwd: root, timeout: 90_000 },
  );
}
