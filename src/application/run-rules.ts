import { compareBytes } from "../domain/byte-order.js";
import type {
  RunClaim,
  RunEvidenceRange,
  RunEvidenceReference,
} from "../domain/run-comparison.js";
import { sanitizeText } from "../domain/sanitize.js";
import type { PatchFile } from "../input/yuurei-patch.js";
import type {
  ManifestEntry,
  PatchState,
  YuureiRun,
} from "../input/yuurei-run.js";

/** One run-comparison claim rule, evaluated against the two loaded runs. */
export interface RunRule {
  readonly ruleId: string;
  evaluate(view: RunComparisonView): readonly RunClaim[];
}

/** The comparison view consumed by the run rules. */
export interface RunComparisonView {
  readonly before: YuureiRun;
  readonly after: YuureiRun;
}

const SOURCE_ORDER: Record<string, number> = {
  beforeTrace: 0,
  afterTrace: 1,
  beforeManifest: 2,
  afterManifest: 3,
  beforePatch: 4,
  afterPatch: 5,
};

/** Sorts evidence per contract: by source order, then pointer byte order. */
function sortEvidence(
  evidence: readonly RunEvidenceReference[],
): RunEvidenceReference[] {
  return [...evidence].sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      compareBytes(a.pointer, b.pointer),
  );
}

function claim(
  ruleId: string,
  text: string,
  evidence: readonly RunEvidenceReference[],
  confidence = 1,
): RunClaim {
  return {
    claim: sanitizeText(text),
    ruleId,
    evidence: sortEvidence(evidence),
    provenance: { transform: ["compare-runs", `rule:${ruleId}`] },
    confidence,
  };
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

type Side = "A" | "B";
type ManifestSource = "beforeManifest" | "afterManifest";
type PatchSource = "beforePatch" | "afterPatch";

const SIDES = [
  {
    name: "A" as Side,
    manifest: "beforeManifest" as ManifestSource,
    patch: "beforePatch" as PatchSource,
  },
  {
    name: "B" as Side,
    manifest: "afterManifest" as ManifestSource,
    patch: "afterPatch" as PatchSource,
  },
] as const;

/** The manifest pointer of a run's patch entry, when one is listed. */
function patchPointer(run: YuureiRun): string | null {
  return run.patchEntryIndex === null
    ? null
    : `/artifacts/${run.patchEntryIndex}`;
}

/** The manifest pointer of a patch entry, or the manifest root with a note. */
function patchPresenceEvidence(
  run: YuureiRun,
  source: ManifestSource,
): RunEvidenceReference {
  const pointer = patchPointer(run);
  return pointer === null
    ? { source, pointer: "", note: "no patch.diff entry" }
    : { source, pointer };
}

/** The recorded digest of a run's patch entry; callers emit patch evidence only when the patch parsed, which requires a listed entry. */
function patchDigest(run: YuureiRun): string {
  const index = run.patchEntryIndex;
  return index === null ? "" : run.entries[index].digest;
}

/** Evidence citing a generated file's block inside a verified patch. */
function fileEvidence(
  run: YuureiRun,
  source: PatchSource,
  file: PatchFile,
  range?: { lines: RunEvidenceRange; bytes: RunEvidenceRange },
): RunEvidenceReference {
  return {
    source,
    pointer: patchPointer(run) ?? "",
    digest: patchDigest(run),
    path: file.path,
    lines: range?.lines ?? { start: file.startLine, end: file.endLine },
    bytes: range?.bytes ?? { start: file.byteStart, end: file.byteEnd },
  };
}

/** Evidence for a file a verified patch does not record. */
function absentFileEvidence(
  run: YuureiRun,
  source: PatchSource,
  path: string,
): RunEvidenceReference {
  return {
    source,
    pointer: patchPointer(run) ?? "",
    digest: patchDigest(run),
    note: `no block for '${path}'`,
  };
}

/** Whether two recorded files carry identical generated content. */
function sameContent(a: PatchFile, b: PatchFile): boolean {
  return (
    a.trailingNewline === b.trailingNewline &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, index) => line === b.lines[index])
  );
}

/**
 * The index range of content lines that differ between two recorded files:
 * the common prefix and suffix are excluded, so each side's range covers
 * only its changed lines. An empty range on one side means that side's
 * content is a strict prefix/suffix of the other's (or that only the
 * trailing-newline marker differs).
 */
function diffRegion(
  a: readonly string[],
  b: readonly string[],
): { aStart: number; aEnd: number; bStart: number; bEnd: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start])
    start += 1;
  let suffix = 0;
  while (
    suffix < a.length - start &&
    suffix < b.length - start &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix += 1;
  return {
    aStart: start,
    aEnd: a.length - suffix,
    bStart: start,
    bEnd: b.length - suffix,
  };
}

/** The patch line/byte range covering a side's changed content region. */
function regionRange(file: PatchFile, start: number, end: number) {
  if (start < end) {
    const first = file.contentLines[start];
    const last = file.contentLines[end - 1];
    return {
      lines: { start: first.lineNumber, end: last.lineNumber },
      bytes: { start: first.byteStart, end: last.byteEnd },
    };
  }
  // The region is empty (a pure insertion on the other side, or a
  // trailing-newline-only difference): cite the whole block instead.
  return {
    lines: { start: file.startLine, end: file.endLine },
    bytes: { start: file.byteStart, end: file.byteEnd },
  };
}

export interface PatchSetDiff {
  /** Files recorded only by B's patch, in path byte order. */
  readonly added: readonly PatchFile[];
  /** Files recorded only by A's patch, in path byte order. */
  readonly removed: readonly PatchFile[];
  /** Files recorded by both with differing content, in path byte order. */
  readonly changed: readonly {
    readonly file: PatchFile;
    readonly before: PatchFile;
    readonly after: PatchFile;
  }[];
  readonly identical: readonly PatchFile[];
}

/**
 * Compares the generated-file sets two verified patches record. The result
 * is sorted by UTF-8 byte order of the workspace path, independent of block
 * order inside either patch.
 */
export function diffPatchSets(
  before: readonly PatchFile[],
  after: readonly PatchFile[],
): PatchSetDiff {
  const beforeByPath = new Map(before.map((file) => [file.path, file]));
  const afterByPath = new Map(after.map((file) => [file.path, file]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])];
  paths.sort(compareBytes);
  const added: PatchFile[] = [];
  const removed: PatchFile[] = [];
  const changed: PatchSetDiff["changed"][number][] = [];
  const identical: PatchFile[] = [];
  for (const path of paths) {
    const a = beforeByPath.get(path);
    const b = afterByPath.get(path);
    if (a === undefined) added.push(b as PatchFile);
    else if (b === undefined) removed.push(a);
    else if (sameContent(a, b)) identical.push(a);
    else changed.push({ file: a, before: a, after: b });
  }
  return { added, removed, changed, identical };
}

/** A short descriptive phrase for a patch state, no judgement. */
function patchStatePhrase(state: PatchState): string {
  switch (state) {
    case "not-recorded":
      return "not recorded in its manifest";
    case "missing":
      return "recorded in its manifest but missing from the run directory";
    case "digest-mismatch":
      return "recorded but its stored bytes do not match the manifest's digest";
    case "malformed":
      return "verified but its bytes do not match the patch grammar";
    case "unverified":
      return "recorded but not verifiable in this milestone";
    case "verified":
      return "verified";
    case "verified-truncated":
      return "verified and marked truncated";
  }
}

/** Why an `unverified` entry was not verified, for claim text. */
function unverifiedReason(entry: ManifestEntry): string {
  if (entry.path !== "patch.diff")
    return "its bytes are not read in this milestone";
  if (!SHA256_DIGEST.test(entry.digest))
    return "the recorded digest is not a sha256 digest";
  return "the stored file could not be read within the input limits";
}

function entryStateText(entry: ManifestEntry): string {
  switch (entry.state) {
    case "verified":
      return "the stored bytes verify against the recorded digest";
    case "verified-truncated":
      return (
        "the stored bytes verify against the recorded digest and the entry " +
        "is marked truncated, so the stored bytes are a cut prefix of what " +
        "the run emitted"
      );
    case "digest-mismatch":
      return (
        "the stored bytes do not hash to the recorded digest, so the " +
        "recorded content is not interpreted"
      );
    case "missing":
      return "the manifest records it but no readable file exists at that path";
    case "unverified":
      return `the artifact is recorded but unverified: ${unverifiedReason(entry)}`;
  }
}

function sortedEntries(run: YuureiRun): ManifestEntry[] {
  return [...run.entries].sort((a, b) => compareBytes(a.path, b.path));
}

export const RUN_RULES: readonly RunRule[] = [
  {
    // One claim per manifest entry per side, in path byte order: the
    // recorded facts (path, kind, digest, truncation) and the verification
    // outcome. Manifest order does not affect the output.
    ruleId: "run-manifest",
    evaluate(view) {
      const claims: RunClaim[] = [];
      for (const [run, side] of [
        [view.before, SIDES[0]],
        [view.after, SIDES[1]],
      ] as const) {
        for (const entry of sortedEntries(run)) {
          const evidence: RunEvidenceReference[] = [
            { source: side.manifest, pointer: `/artifacts/${entry.index}` },
            {
              source: side.manifest,
              pointer: `/artifacts/${entry.index}/path`,
            },
            {
              source: side.manifest,
              pointer: `/artifacts/${entry.index}/digest`,
            },
          ];
          if (entry.truncated)
            evidence.push({
              source: side.manifest,
              pointer: `/artifacts/${entry.index}/truncated`,
            });
          claims.push(
            claim(
              "run-manifest",
              `Run ${side.name}'s manifest records artifact '${entry.path}' ` +
                `(kind '${entry.kind}', digest '${entry.digest}'` +
                `${entry.truncated ? ", truncated" : ""}` +
                `${entry.bytes === undefined ? "" : `, ${entry.bytes} bytes`}): ` +
                `${entryStateText(entry)}.`,
              evidence,
            ),
          );
        }
      }
      return claims;
    },
  },
  {
    // One caveat per side whose patch is anything but cleanly verified:
    // unrecorded, missing, unverifiable, mismatched, malformed, or
    // truncated. These caveats bound what the file-level claims can say.
    ruleId: "run-patch-state",
    evaluate(view) {
      const claims: RunClaim[] = [];
      for (const [run, side] of [
        [view.before, SIDES[0]],
        [view.after, SIDES[1]],
      ] as const) {
        const state = run.patchState;
        if (state === "verified") continue;
        let text: string;
        if (state === "not-recorded")
          text =
            `Run ${side.name}'s manifest records no patch.diff entry; ` +
            `yuurei records the artifact only when patch generation ` +
            `succeeded, so the generated-file record is unavailable — ` +
            `this does not mean the run produced no workspace output.`;
        else if (state === "verified-truncated")
          text =
            `Run ${side.name}'s patch.diff verifies against the manifest ` +
            `but is marked truncated at yuurei's size cap; ` +
            (run.patch?.complete === false
              ? `${plural(run.patch.files.length, "file")} are recorded in ` +
                `the stored prefix and anything past the cut is unknown.`
              : `the stored bytes nonetheless form a complete patch.`);
        else
          text =
            `Run ${side.name}'s patch.diff is ${patchStatePhrase(state)}; ` +
            `its generated-file content is not interpreted.`;
        claims.push(
          claim("run-patch-state", text, [
            patchPresenceEvidence(run, side.manifest),
          ]),
        );
      }
      return claims;
    },
  },
  {
    // The aggregate generated-file comparison, always emitted: identical
    // sets, the difference counts, or why the comparison is limited.
    ruleId: "run-generated-files",
    evaluate(view) {
      const { before, after } = view;
      const a = before.patch;
      const b = after.patch;
      const evidence = [
        patchPresenceEvidence(before, "beforeManifest"),
        patchPresenceEvidence(after, "afterManifest"),
      ];
      const caveat =
        " A patch records only representable text files — binary, " +
        "oversized, over-cap, and unrepresentably named files are omitted — " +
        "so a file absent from a patch is not evidence the run did not " +
        "write it.";
      const truncatedNote = (run: YuureiRun, name: Side) =>
        run.patch?.complete === false
          ? ` Run ${name}'s patch is truncated: the comparison covers only ` +
            `its stored prefix.`
          : "";
      let text: string;
      if (a !== null && b !== null) {
        const diff = diffPatchSets(a.files, b.files);
        if (
          diff.added.length === 0 &&
          diff.removed.length === 0 &&
          diff.changed.length === 0
        )
          text =
            `Both runs' patches record the same ` +
            `${plural(diff.identical.length, "generated file")} with ` +
            `identical content.`;
        else
          text =
            `Run A's patch records ${plural(a.files.length, "generated file")} ` +
            `and run B's records ${plural(b.files.length, "generated file")}: ` +
            `${diff.identical.length} identical, ` +
            `${diff.changed.length} changed, ` +
            `${diff.removed.length} recorded only by A, ` +
            `${diff.added.length} recorded only by B.`;
        text += truncatedNote(before, "A") + truncatedNote(after, "B");
        text += caveat;
      } else if (a === null && b === null) {
        text =
          `Neither run's patch could be interpreted (A: ` +
          `${patchStatePhrase(before.patchState)}; B: ` +
          `${patchStatePhrase(after.patchState)}); no generated-file ` +
          `comparison is possible.`;
      } else {
        const knownPatch = a === null ? b : a;
        const knownSide = a === null ? "B" : "A";
        const unknown = a === null ? before : after;
        const unknownSide = a === null ? "A" : "B";
        text =
          `Run ${knownSide}'s patch records ` +
          `${plural(knownPatch!.files.length, "generated file")}; ` +
          `run ${unknownSide}'s patch is ` +
          `${patchStatePhrase(unknown.patchState)}, so the file-level ` +
          `comparison covers only run ${knownSide}'s record.` +
          caveat;
      }
      return [claim("run-generated-files", text, evidence)];
    },
  },
  {
    // One claim per generated file recorded only by B's patch.
    ruleId: "run-file-added",
    evaluate(view) {
      if (view.before.patch === null || view.after.patch === null) return [];
      const diff = diffPatchSets(
        view.before.patch.files,
        view.after.patch.files,
      );
      return diff.added.map((file) =>
        claim(
          "run-file-added",
          `Run B's patch records the generated file '${file.path}' (` +
            (file.lines.length === 0
              ? "an empty file"
              : plural(file.lines.length, "added line")) +
            `); run A's patch does not record it.`,
          [
            fileEvidence(view.after, "afterPatch", file),
            absentFileEvidence(view.before, "beforePatch", file.path),
          ],
        ),
      );
    },
  },
  {
    // One claim per generated file recorded only by A's patch.
    ruleId: "run-file-removed",
    evaluate(view) {
      if (view.before.patch === null || view.after.patch === null) return [];
      const diff = diffPatchSets(
        view.before.patch.files,
        view.after.patch.files,
      );
      return diff.removed.map((file) =>
        claim(
          "run-file-removed",
          `Run A's patch records the generated file '${file.path}' (` +
            (file.lines.length === 0
              ? "an empty file"
              : plural(file.lines.length, "added line")) +
            `); run B's patch does not record it.`,
          [
            fileEvidence(view.before, "beforePatch", file),
            absentFileEvidence(view.after, "afterPatch", file.path),
          ],
        ),
      );
    },
  },
  {
    // One claim per generated file recorded by both patches with differing
    // content, citing each side's differing line region.
    ruleId: "run-file-changed",
    evaluate(view) {
      if (view.before.patch === null || view.after.patch === null) return [];
      const diff = diffPatchSets(
        view.before.patch.files,
        view.after.patch.files,
      );
      return diff.changed.map(({ file, before, after }) => {
        const region = diffRegion(before.lines, after.lines);
        return claim(
          "run-file-changed",
          `Both runs' patches record '${file.path}' but the generated ` +
            `content differs: run A records ` +
            `${plural(before.lines.length, "line")}, run B records ` +
            `${plural(after.lines.length, "line")}.`,
          [
            fileEvidence(
              view.before,
              "beforePatch",
              before,
              regionRange(before, region.aStart, region.aEnd),
            ),
            fileEvidence(
              view.after,
              "afterPatch",
              after,
              regionRange(after, region.bStart, region.bEnd),
            ),
          ],
        );
      });
    },
  },
];
