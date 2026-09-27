import { compareBytes } from "../domain/byte-order.js";
import {
  AUDIT_SCHEMA_VERSION,
  type AuditCheckReportDescriptor,
  type AuditCompleteness,
  type AuditEvidenceReference,
  type AuditEvidenceSource,
  type AuditFact,
  type AuditResult,
} from "../domain/audit.js";
import { sanitizeText } from "../domain/sanitize.js";
import {
  assertAuditEvidenceResolves,
  assertValidAuditResult,
} from "../domain/validate-audit.js";
import type {
  AuditedArtifactRecord,
  AuditedRun,
} from "../input/yuurei-audit-run.js";
import { PflExportError } from "../input/pfl-export.js";
import type { LoadedCheckReport } from "./check-report-binding.js";
import { evaluationRunInput, runContext } from "./evaluate-run.js";
import { MAX_EMITTED_CLAIMS, MAX_EVIDENCE_REFERENCES } from "./limits.js";

// The fixed audit fact list (docs/v0.8-scope.md) is emitted in the order
// the auditRun() body below builds it; the `check-report.*` facts follow
// once per supplied report, in argument order. Absent records surface as
// `not-recorded` facts rather than dropped rows, so the output shape never
// depends on input content.

const CHANGE_KINDS = ["added", "modified", "deleted"] as const;

/**
 * A matching subject declaration is the report's own claim about which
 * bytes it evaluated; it never attests that the evaluator ran on them.
 */
const SELF_DECLARED =
  "a matching declaration is self-reported and does not attest that the " +
  "evaluator ran on those bytes";

const SOURCE_ORDER: Record<AuditEvidenceSource, number> = {
  trace: 0,
  manifest: 1,
  baselineManifest: 2,
  changes: 3,
  patch: 4,
  result: 5,
  checkReport: 6,
};

/** Sorts evidence per contract: by source order, then pointer byte order. */
function sortEvidence(
  evidence: readonly AuditEvidenceReference[],
): AuditEvidenceReference[] {
  return [...evidence].sort(
    (a, b) =>
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      compareBytes(a.pointer, b.pointer),
  );
}

function fact(
  id: string,
  state: AuditFact["state"],
  completeness: AuditCompleteness,
  reason: string,
  evidence: readonly AuditEvidenceReference[],
  subject?: string,
): AuditFact {
  return {
    id,
    ...(subject === undefined ? {} : { subject }),
    state,
    completeness,
    reason: sanitizeText(reason),
    evidence: sortEvidence(evidence),
    provenance: { transform: ["audit-run", `fact:${id}`] },
  };
}

// -- evidence constructors --------------------------------------------------

function traceEv(pointer: string, note?: string): AuditEvidenceReference {
  return {
    source: "trace",
    pointer,
    ...(note === undefined ? {} : { note }),
  };
}

function manifestEv(pointer: string, note?: string): AuditEvidenceReference {
  return {
    source: "manifest",
    pointer,
    ...(note === undefined ? {} : { note }),
  };
}

/** Evidence citing a manifest entry, or the manifest root when unlisted. */
function entryEv(
  entryIndex: number | null,
  note?: string,
): AuditEvidenceReference {
  return entryIndex === null
    ? manifestEv("", note ?? "no such manifest entry")
    : manifestEv(`/artifacts/${entryIndex}`, note);
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Evidence citing an artifact's manifest entry under its byte source. */
function artifactEv(
  source: "patch" | "result",
  run: AuditedRun,
  entryIndex: number,
  note?: string,
): AuditEvidenceReference {
  const digest = run.entries[entryIndex].digest;
  return {
    source,
    pointer: `/artifacts/${entryIndex}`,
    ...(SHA256_DIGEST.test(digest) ? { digest } : {}),
    ...(note === undefined ? {} : { note }),
  };
}

/** Evidence citing a location inside a verified supplemental JSON record. */
function recordEv(
  source: "baselineManifest" | "changes",
  record: AuditedArtifactRecord,
  pointer: string,
  note?: string,
): AuditEvidenceReference {
  return {
    source,
    pointer,
    ...(record.digest !== null && SHA256_DIGEST.test(record.digest)
      ? { digest: record.digest }
      : {}),
    ...(note === undefined ? {} : { note }),
  };
}

function reportEv(
  label: string,
  pointer: string,
  note?: string,
): AuditEvidenceReference {
  return {
    source: "checkReport",
    pointer,
    elementId: label,
    ...(note === undefined ? {} : { note }),
  };
}

function diagnosticEv(index: number): AuditEvidenceReference {
  return traceEv(`/diagnostics/${index}`);
}

// -- shared per-artifact integrity check ------------------------------------

/**
 * The stored-byte integrity fact shared by `patch.stored`, `result.stored`,
 * `baseline-manifest.stored`, and `changes.stored`: the manifest records
 * the path and the stored bytes hash to its recorded digest. A digest
 * mismatch is a contradiction between the manifest record and the stored
 * bytes (`inconsistent`); an absent or unreadable file leaves the record's
 * integrity uncheckable (`unverifiable`).
 */
function storedFact(
  id: string,
  run: AuditedRun,
  entryIndex: number | null,
  name: string,
  notRecordedNote?: string,
): AuditFact {
  const evidence = [
    entryEv(entryIndex, entryIndex === null ? `no ${name} entry` : undefined),
  ];
  if (entryIndex === null)
    return fact(
      id,
      "not-recorded",
      "unknown",
      notRecordedNote ?? `the manifest records no ${name} entry`,
      evidence,
    );
  const entry = run.entries[entryIndex];
  switch (entry.state) {
    case "verified":
      return fact(
        id,
        "verified",
        "complete",
        `the manifest records ${name} and the stored bytes match its ` +
          "recorded digest",
        evidence,
      );
    case "verified-truncated":
      return fact(
        id,
        "verified",
        "partial",
        `the stored ${name} bytes match the recorded digest but are ` +
          "marked truncated — the digest attests the cut prefix only",
        evidence,
      );
    case "digest-mismatch":
      return fact(
        id,
        "inconsistent",
        "unknown",
        `the stored ${name} bytes do not hash to the manifest's recorded ` +
          "digest; the records contradict and the bytes are never interpreted",
        evidence,
      );
    case "missing":
      return fact(
        id,
        "unverifiable",
        "unknown",
        `the manifest records ${name} but no readable file exists at its ` +
          "path",
        evidence,
      );
    default:
      return fact(
        id,
        "unverifiable",
        "unknown",
        `the manifest records ${name} but its stored bytes were not ` +
          `verified (${entry.state})`,
        evidence,
      );
  }
}

// -- run-document and seeded-identity facts ---------------------------------

function auditRunDocuments(): AuditFact[] {
  return [
    fact(
      "run.trace",
      "verified",
      "complete",
      "the run records a trace.json document that conforms to the trace " +
        "contract",
      [traceEv("")],
    ),
    fact(
      "run.manifest",
      "verified",
      "complete",
      "the run records an artifacts.json manifest that conforms to the " +
        "run-directory contract",
      [manifestEv("")],
    ),
  ];
}

function auditSeedFacts(run: AuditedRun): AuditFact[] {
  const facts: AuditFact[] = [];
  const seed = run.trace.seed;
  const seeded = seed !== undefined;

  facts.push(
    seeded
      ? fact(
          "seed.provenance",
          "verified",
          "complete",
          "the trace records seeded-workspace provenance",
          [traceEv("/seed")],
        )
      : fact(
          "seed.provenance",
          "not-recorded",
          "complete",
          "the trace records no seed field; this is a legacy " +
            "empty-workspace run",
          [traceEv("", "no seed field")],
        ),
  );

  const cell = run.trace.requestedCell;
  if (cell === undefined) {
    facts.push(
      fact(
        "seed.inputs-version",
        "not-recorded",
        "complete",
        "the trace records no requested_cell.inputs_version declaration",
        [traceEv("", "no requested_cell field")],
      ),
    );
  } else {
    const expected = seeded ? 2 : 1;
    facts.push(
      cell.inputsVersion === expected
        ? fact(
            "seed.inputs-version",
            "verified",
            "complete",
            `requested_cell.inputs_version ${cell.inputsVersion} agrees ` +
              `with the run's ${seeded ? "seeded" : "empty-workspace"} record`,
            [traceEv("/requested_cell/inputs_version")],
          )
        : fact(
            "seed.inputs-version",
            "inconsistent",
            "complete",
            `requested_cell.inputs_version ${cell.inputsVersion} ` +
              `contradicts the trace's ` +
              (seeded ? "seed record" : "absent seed record") +
              ` (${expected} expected)`,
            [
              traceEv("/requested_cell/inputs_version"),
              seeded ? traceEv("/seed") : traceEv("", "no seed field"),
            ],
          ),
    );
  }

  const patchRecord = run.patchRecord;
  if (patchRecord === undefined) {
    facts.push(
      fact(
        "seed.patch-base",
        "not-recorded",
        "complete",
        "the trace predates the patch completeness record",
        [traceEv("", "no patch field")],
      ),
    );
  } else {
    const agrees = (patchRecord.base === "seeded") === seeded;
    const evidence = [traceEv("/patch/base")];
    if (seeded) evidence.push(traceEv("/seed"));
    else evidence.push(traceEv("", "no seed field"));
    facts.push(
      agrees
        ? fact(
            "seed.patch-base",
            "verified",
            "complete",
            `patch.base '${patchRecord.base}' agrees with the ` +
              (seeded ? "seed record" : "absent seed record"),
            evidence,
          )
        : fact(
            "seed.patch-base",
            "inconsistent",
            "complete",
            `patch.base '${patchRecord.base}' contradicts the trace's ` +
              (seeded ? "seed record" : "absent seed record"),
            evidence,
          ),
    );
  }

  if (!seeded) {
    facts.push(
      fact(
        "seed.baseline-materialization",
        "not-recorded",
        "complete",
        "the run records no seeded baseline declaration",
        [traceEv("", "no seed field")],
      ),
    );
  } else {
    const { requestedDigest, materializedDigest } = seed.baseline;
    const evidence = [
      traceEv("/seed/baseline/requested_digest"),
      traceEv("/seed/baseline/materialized_digest"),
    ];
    facts.push(
      requestedDigest === materializedDigest
        ? fact(
            "seed.baseline-materialization",
            "verified",
            "complete",
            "the declared requested and materialized baseline digests " +
              "agree; identity equality only — the baseline bytes " +
              "themselves are never read",
            evidence,
          )
        : fact(
            "seed.baseline-materialization",
            "inconsistent",
            "complete",
            "the declared requested and materialized baseline digests " +
              "differ",
            evidence,
          ),
    );
  }

  if (!seeded) {
    facts.push(
      fact(
        "seed.changes-record",
        "not-recorded",
        "complete",
        "the run records no seeded change set",
        [traceEv("", "no seed field")],
      ),
    );
  } else if (seed.changes === undefined) {
    facts.push(
      fact(
        "seed.changes-record",
        "not-recorded",
        "unknown",
        "the trace records no seed.changes; the run's change set is " +
          "unknown, never 'no changes'",
        [traceEv("/seed", "no changes field")],
      ),
    );
  } else {
    facts.push(
      fact(
        "seed.changes-record",
        "verified",
        "complete",
        `the trace records the change set (added: ${seed.changes.added}, ` +
          `modified: ${seed.changes.modified}, deleted: ` +
          `${seed.changes.deleted})`,
        [traceEv("/seed/changes")],
      ),
    );
  }
  return facts;
}

// -- supplemental record facts ----------------------------------------------

/**
 * The stored/record facts for one seeded supplemental record
 * (`baseline-manifest.json` or `changes.json`). On a legacy run a listed
 * record is not interpreted — there is no seed to check it against.
 */
function auditBaselineManifest(run: AuditedRun): AuditFact[] {
  const id = "baseline-manifest";
  const record = run.baselineManifest;
  const path = "baseline-manifest.json";
  const facts: AuditFact[] = [];
  if (!run.seeded) {
    for (const suffix of ["stored", "record"] as const)
      facts.push(
        record.entryIndex === null
          ? fact(
              `${id}.${suffix}`,
              "not-recorded",
              "unknown",
              `the manifest records no ${path} entry`,
              [manifestEv("", `no ${path} entry`)],
            )
          : fact(
              `${id}.${suffix}`,
              "unverifiable",
              "unknown",
              `the run is not seeded; the listed ${path} record is not ` +
                "interpreted on a legacy run",
              [entryEv(record.entryIndex)],
            ),
      );
    return facts;
  }

  facts.push(
    storedFact(
      `${id}.stored`,
      run,
      record.entryIndex,
      path,
      `the manifest records no ${path} entry`,
    ),
  );

  if (record.entryIndex === null)
    return [
      ...facts,
      fact(
        `${id}.record`,
        "not-recorded",
        "unknown",
        `the manifest records no ${path} entry`,
        [manifestEv("", `no ${path} entry`)],
      ),
    ];
  if (record.state !== "verified") {
    return [
      ...facts,
      fact(
        `${id}.record`,
        "unverifiable",
        record.state === "verified-truncated" ? "partial" : "unknown",
        `the ${path} record is ${record.state}; its content cannot be ` +
          "checked against the trace's seed record",
        [entryEv(record.entryIndex)],
      ),
    ];
  }
  const doc = record.document;
  if (doc === null) {
    return [
      ...facts,
      fact(
        `${id}.record`,
        "inconsistent",
        "complete",
        record.documentError ??
          `the verified ${path} is not the documented record`,
        [entryEv(record.entryIndex, record.documentError ?? undefined)],
      ),
    ];
  }

  const seed = run.trace.seed!;
  const checks: [string, unknown, unknown][] = [
    ["version", doc.version, 1],
    ["policy", doc.policy, seed.policy],
    ["source", doc.source, seed.source],
    ["head", doc.head, seed.head],
    ["requested_digest", doc.requested_digest, seed.baseline.requestedDigest],
    [
      "materialized_digest",
      doc.materialized_digest,
      seed.baseline.materializedDigest,
    ],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected)
      return [
        ...facts,
        fact(
          `${id}.record`,
          "inconsistent",
          "complete",
          `the verified ${path} field '${field}' does not restate the ` +
            "trace's seed record",
          [traceEv("/seed"), recordEv("baselineManifest", record, `/${field}`)],
        ),
      ];
  }
  const files = doc.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    return [
      ...facts,
      fact(
        `${id}.record`,
        "inconsistent",
        "complete",
        `the verified ${path} field 'files' is not the documented ` +
          "file map",
        [recordEv("baselineManifest", record, "/files")],
      ),
    ];
  }
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length !== seed.baseline.files) {
    return [
      ...facts,
      fact(
        `${id}.record`,
        "inconsistent",
        "complete",
        `the verified ${path} records ${entries.length} file(s) but the ` +
          `trace's seed.baseline.files is ${seed.baseline.files}`,
        [
          traceEv("/seed/baseline/files"),
          recordEv("baselineManifest", record, "/files"),
        ],
      ),
    ];
  }
  let totalBytes = 0;
  for (const [path, fileEntry] of entries) {
    const entry = fileEntry as Record<string, unknown>;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.digest !== "string" ||
      !Number.isSafeInteger(entry.mode) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 0
    ) {
      return [
        ...facts,
        fact(
          `${id}.record`,
          "inconsistent",
          "complete",
          `the verified ${path} file entry '${path}' is not the ` +
            "documented { digest, mode, bytes } shape",
          [
            recordEv(
              "baselineManifest",
              record,
              `/files/${path.replace(/~/g, "~0").replace(/\//g, "~1")}`,
            ),
          ],
        ),
      ];
    }
    totalBytes += entry.bytes as number;
  }
  if (totalBytes !== seed.baseline.bytes) {
    return [
      ...facts,
      fact(
        `${id}.record`,
        "inconsistent",
        "complete",
        `the verified ${path} file entries total ${totalBytes} bytes ` +
          `but the trace's seed.baseline.bytes is ${seed.baseline.bytes}`,
        [
          traceEv("/seed/baseline/bytes"),
          recordEv("baselineManifest", record, "/files"),
        ],
      ),
    ];
  }
  return [
    ...facts,
    fact(
      `${id}.record`,
      "verified",
      "complete",
      `the verified ${path} restates the trace's seed record and file ` +
        "inventory",
      [recordEv("baselineManifest", record, ""), traceEv("/seed")],
    ),
  ];
}

function auditChanges(run: AuditedRun): AuditFact[] {
  const id = "changes";
  const record = run.changes;
  const path = "changes.json";
  const facts: AuditFact[] = [];
  if (!run.seeded) {
    for (const suffix of ["stored", "record"] as const)
      facts.push(
        record.entryIndex === null
          ? fact(
              `${id}.${suffix}`,
              "not-recorded",
              "unknown",
              `the manifest records no ${path} entry`,
              [manifestEv("", `no ${path} entry`)],
            )
          : fact(
              `${id}.${suffix}`,
              "unverifiable",
              "unknown",
              `the run is not seeded; the listed ${path} record is not ` +
                "interpreted on a legacy run",
              [entryEv(record.entryIndex)],
            ),
      );
    return facts;
  }

  facts.push(
    storedFact(
      `${id}.stored`,
      run,
      record.entryIndex,
      path,
      `the manifest records no ${path} entry`,
    ),
  );

  const seed = run.trace.seed!;
  if (record.entryIndex === null)
    return [
      ...facts,
      fact(
        `${id}.record`,
        "not-recorded",
        "unknown",
        `the manifest records no ${path} entry`,
        [manifestEv("", `no ${path} entry`)],
      ),
    ];
  if (record.state !== "verified") {
    return [
      ...facts,
      fact(
        `${id}.record`,
        "unverifiable",
        record.state === "verified-truncated" ? "partial" : "unknown",
        `the ${path} record is ${record.state}; its content cannot be ` +
          "checked",
        [entryEv(record.entryIndex)],
      ),
    ];
  }
  const doc = record.document;
  if (doc === null) {
    return [
      ...facts,
      fact(
        `${id}.record`,
        "inconsistent",
        "complete",
        record.documentError ??
          `the verified ${path} is not the documented record`,
        [entryEv(record.entryIndex, record.documentError ?? undefined)],
      ),
    ];
  }
  if (doc.version !== 1)
    return [
      ...facts,
      fact(
        `${id}.record`,
        "inconsistent",
        "complete",
        `the verified ${path} field 'version' is not 1`,
        [recordEv("changes", record, "/version")],
      ),
    ];
  if (doc.baseline_digest !== seed.baseline.requestedDigest)
    return [
      ...facts,
      fact(
        `${id}.record`,
        "inconsistent",
        "complete",
        `the verified ${path} field 'baseline_digest' does not match ` +
          "the trace's requested baseline digest",
        [
          traceEv("/seed/baseline/requested_digest"),
          recordEv("changes", record, "/baseline_digest"),
        ],
      ),
    ];
  if (seed.changes === undefined)
    return [
      ...facts,
      fact(
        `${id}.record`,
        "inconsistent",
        "complete",
        `the verified ${path} exists but the trace records no ` +
          "seed.changes — change collection did not complete",
        [recordEv("changes", record, ""), traceEv("/seed")],
      ),
    ];
  for (const kind of CHANGE_KINDS) {
    const value = doc[kind];
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string")
    ) {
      return [
        ...facts,
        fact(
          `${id}.record`,
          "inconsistent",
          "complete",
          `the verified ${path} field '${kind}' is not a path list`,
          [recordEv("changes", record, `/${kind}`)],
        ),
      ];
    }
    if (value.length !== seed.changes[kind]) {
      return [
        ...facts,
        fact(
          `${id}.record`,
          "inconsistent",
          "complete",
          `the verified ${path} records ${value.length} ${kind} ` +
            `path(s) but the trace's seed.changes.${kind} is ` +
            `${seed.changes[kind]}`,
          [
            traceEv(`/seed/changes/${kind}`),
            recordEv("changes", record, `/${kind}`),
          ],
        ),
      ];
    }
  }
  return [
    ...facts,
    fact(
      `${id}.record`,
      "verified",
      "complete",
      `the verified ${path} restates the trace's declared change set`,
      [recordEv("changes", record, ""), traceEv("/seed/changes")],
    ),
  ];
}

// -- patch facts --------------------------------------------------------------

function auditPatchInterpretable(run: AuditedRun): AuditFact {
  const id = "patch.interpretable";
  if (run.patchEntryIndex === null)
    return fact(
      id,
      "not-recorded",
      "unknown",
      "the manifest records no patch.diff entry",
      [manifestEv("", "no patch.diff entry")],
    );
  const entry = run.entries[run.patchEntryIndex];
  const verifiedBytes =
    entry.state === "verified" || entry.state === "verified-truncated";
  if (!verifiedBytes)
    return fact(
      id,
      "unverifiable",
      "unknown",
      `the patch is ${entry.state}; no verified bytes exist to parse`,
      [entryEv(run.patchEntryIndex)],
    );
  if (run.patchGrammarAmbiguous)
    return fact(
      id,
      "unverifiable",
      "unknown",
      "patch.base contradicts the seed record; no single patch grammar " +
        "applies to the verified bytes",
      [traceEv("/patch/base"), artifactEv("patch", run, run.patchEntryIndex)],
    );
  if (run.patchMalformed)
    return fact(
      id,
      "inconsistent",
      entry.truncated ? "partial" : "complete",
      "the verified patch.diff bytes violate the run's documented patch " +
        "grammar",
      [artifactEv("patch", run, run.patchEntryIndex, "malformed")],
    );
  const completeness: AuditCompleteness =
    entry.truncated || run.patch?.complete === false ? "partial" : "complete";
  return fact(
    id,
    "verified",
    completeness,
    completeness === "partial"
      ? "the verified patch.diff bytes parse under the run's grammar; " +
          "the stored prefix may omit a cut tail"
      : "the verified patch.diff bytes parse under the run's grammar",
    [artifactEv("patch", run, run.patchEntryIndex)],
  );
}

function auditPatchRecord(run: AuditedRun): AuditFact {
  const id = "patch.record";
  const rec = run.patchRecord;
  const entry = run.patchEntryIndex;
  const inconsistent = (
    reason: string,
    evidence: AuditEvidenceReference[],
  ): AuditFact => fact(id, "inconsistent", "complete", reason, evidence);

  if (rec === undefined) {
    if (run.patchFailureIndex !== -1) {
      const evidence = [diagnosticEv(run.patchFailureIndex), entryEv(entry)];
      return entry === null
        ? fact(
            id,
            "verified",
            "complete",
            "the patch generation-failed diagnostic agrees with the " +
              "absent patch.diff entry",
            evidence,
          )
        : inconsistent(
            "the patch generation-failed diagnostic contradicts the " +
              "manifest's patch.diff entry",
            evidence,
          );
    }
    const evidence = [traceEv("", "no patch field")];
    if (run.patchOmissionIndex !== -1)
      evidence.push(diagnosticEv(run.patchOmissionIndex));
    return fact(
      id,
      "not-recorded",
      "complete",
      "the trace records no patch completeness record" +
        (run.patchOmissionIndex === -1
          ? ""
          : "; omission diagnostics may still mark the stored patch " +
            "partial"),
      evidence,
    );
  }

  const patchEvRefs = () => [traceEv("/patch/state"), entryEv(entry)];
  if (rec.state === "absent" && entry !== null)
    return inconsistent(
      "patch.state 'absent' contradicts the manifest's patch.diff entry",
      patchEvRefs(),
    );
  if (rec.state !== "absent" && entry === null)
    return inconsistent(
      `patch.state '${rec.state}' contradicts the manifest's absent ` +
        "patch.diff record",
      patchEvRefs(),
    );
  if (rec.state === "complete" && run.patchEntryTruncated)
    return inconsistent(
      "patch.state 'complete' contradicts the manifest's truncated " +
        "record for patch.diff",
      patchEvRefs(),
    );
  if (rec.state === "complete" && run.patchOmissionIndex !== -1)
    return inconsistent(
      "patch.state 'complete' contradicts the trace's patch omission " +
        "diagnostics",
      [traceEv("/patch/state"), diagnosticEv(run.patchOmissionIndex)],
    );
  if (rec.state !== "absent" && run.patchFailureIndex !== -1)
    return inconsistent(
      `patch.state '${rec.state}' contradicts the trace's patch ` +
        "generation-failed diagnostic",
      [traceEv("/patch/state"), diagnosticEv(run.patchFailureIndex)],
    );
  return fact(
    id,
    "verified",
    "complete",
    `the patch record (base '${rec.base}', state '${rec.state}') agrees ` +
      "with the manifest and the trace's diagnostics",
    [traceEv("/patch"), entryEv(entry)],
  );
}

function auditPatchCompleteness(run: AuditedRun): AuditFact {
  const id = "patch.completeness";
  const rec = run.patchRecord;
  const entry = run.patchEntryIndex;
  if (entry === null) {
    const absent = rec?.state === "absent" || run.patchFailureIndex !== -1;
    const evidence = [
      ...(rec === undefined ? [] : [traceEv("/patch/state")]),
      ...(run.patchFailureIndex === -1
        ? []
        : [diagnosticEv(run.patchFailureIndex)]),
      manifestEv("", "no patch.diff entry"),
    ];
    return fact(
      id,
      "not-recorded",
      "unknown",
      absent
        ? "the run's records agree no patch was published; no change " +
            "record exists to gauge completeness"
        : "the manifest records no patch.diff entry",
      evidence,
    );
  }
  const entryState = run.entries[entry].state;
  const digestVerified =
    entryState === "verified" || entryState === "verified-truncated";
  const entryRef = artifactEv("patch", run, entry);

  if (rec?.state === "absent")
    return fact(
      id,
      "unverifiable",
      "unknown",
      "the trace declares the patch absent while the manifest lists it; " +
        "the stored bytes' coverage cannot be assessed",
      [traceEv("/patch/state"), entryRef],
    );
  if (rec?.state === "partial")
    return fact(
      id,
      "unverifiable",
      "partial",
      "the trace declares the patch partial; the stored record may omit " +
        "files",
      [traceEv("/patch/state"), entryRef],
    );
  if (!digestVerified || run.patch === null)
    return fact(
      id,
      "unverifiable",
      "unknown",
      `the patch is ${run.patchState}; no verified change record exists ` +
        "to gauge completeness",
      [entryRef],
    );
  if (entryState === "verified-truncated" || run.patch.complete === false)
    return fact(
      id,
      "unverifiable",
      "partial",
      "the stored patch is a cut prefix of what the run emitted; " +
        "coverage of the change set cannot be assessed",
      [entryRef],
    );
  if (rec === undefined)
    return fact(
      id,
      "unverifiable",
      run.patchOmissionIndex === -1 ? "unknown" : "partial",
      "the trace predates the patch completeness record; an untruncated " +
        "patch does not certify coverage of the change set" +
        (run.patchOmissionIndex === -1
          ? ""
          : ", and the trace records omitted patch content"),
      [
        traceEv("", "no patch field"),
        entryRef,
        ...(run.patchOmissionIndex === -1
          ? []
          : [diagnosticEv(run.patchOmissionIndex)]),
      ],
    );
  // rec.state === "complete"
  return fact(
    id,
    "verified",
    "complete",
    "the trace declares the patch complete over verified untruncated " +
      "bytes that parse fully",
    [traceEv("/patch/state"), entryRef],
  );
}

// -- change-set cross-checks --------------------------------------------------

function auditSeedChangesPatch(run: AuditedRun): AuditFact {
  const id = "seed.changes-patch";
  if (!run.seeded)
    return fact(
      id,
      "not-recorded",
      "unknown",
      "the run records no seed; no declared change set exists to check " +
        "the patch against",
      [traceEv("", "no seed field")],
    );
  const changes = run.trace.seed!.changes;
  const patchStateEvidence = [
    traceEv("/patch/state"),
    traceEv("/seed", "no changes field"),
  ];
  if (
    changes === undefined &&
    run.patchRecord !== undefined &&
    run.patchRecord.state !== "absent"
  )
    return fact(
      id,
      "inconsistent",
      "complete",
      `patch.state '${run.patchRecord.state}' declares a published ` +
        "patch but the trace records no seed.changes — shipped yuurei " +
        "publishes a patch only when change collection completes",
      patchStateEvidence,
    );
  if (changes === undefined)
    return fact(
      id,
      "not-recorded",
      "unknown",
      "the trace records no seed.changes; the patch cannot be bounded " +
        "against declared counts",
      [traceEv("/seed", "no changes field")],
    );

  const countsEvidence = (): AuditEvidenceReference[] => [
    traceEv("/seed/changes"),
    ...(run.patchEntryIndex === null
      ? []
      : [artifactEv("patch", run, run.patchEntryIndex)]),
  ];

  if (run.patch === null) {
    if (run.patchEntryIndex === null)
      return fact(
        id,
        "verified",
        "complete",
        "no patch is recorded; nothing contradicts the declared change " +
          "counts",
        [traceEv("/seed/changes"), manifestEv("", "no patch.diff entry")],
      );
    return fact(
      id,
      "unverifiable",
      run.patchEntryTruncated ? "partial" : "unknown",
      `the patch is ${run.patchState}; its per-kind counts cannot be ` +
        "checked against the declared change set",
      countsEvidence(),
    );
  }

  for (const kind of CHANGE_KINDS) {
    const count = run.patch.files.filter((f) => f.change === kind).length;
    if (count > changes[kind])
      return fact(
        id,
        "inconsistent",
        "complete",
        `patch.diff records ${count} ${kind} file(s) but ` +
          `seed.changes.${kind} is ${changes[kind]}`,
        [traceEv(`/seed/changes/${kind}`), ...countsEvidence()],
      );
    if (run.patchRecord?.state === "complete" && count !== changes[kind])
      return fact(
        id,
        "inconsistent",
        "complete",
        `patch.state 'complete' contradicts seed.changes.${kind} ` +
          `${changes[kind]}: patch.diff covers ${count}`,
        [traceEv(`/seed/changes/${kind}`), ...countsEvidence()],
      );
  }
  const partial =
    run.patchRecord?.state === "partial" ||
    run.patchEntryTruncated ||
    run.patch.complete === false;
  return fact(
    id,
    "verified",
    partial ? "partial" : "complete",
    partial
      ? "the parsed patch's per-kind counts stay within the declared " +
          "change set; a partial record may cover only a subset"
      : "the parsed patch's per-kind counts agree with the declared " +
          "change set",
    countsEvidence(),
  );
}

function auditChangesPatchAgreement(run: AuditedRun): AuditFact {
  const id = "changes.patch-agreement";
  const record = run.changes;
  if (!run.seeded)
    return fact(
      id,
      "not-recorded",
      "unknown",
      "the run is not seeded; no change-set record exists to compare " +
        "against the patch",
      [traceEv("", "no seed field")],
    );
  if (record.entryIndex === null)
    return fact(
      id,
      "not-recorded",
      "unknown",
      "the manifest records no changes.json entry to compare the patch " +
        "against",
      [manifestEv("", "no changes.json entry")],
    );
  if (record.document === null)
    return fact(
      id,
      "unverifiable",
      record.state === "verified-truncated" ? "partial" : "unknown",
      `the changes.json record is ${record.state}; its path sets ` +
        "cannot be checked against the patch",
      [entryEv(record.entryIndex)],
    );
  if (run.patchEntryIndex === null)
    return fact(
      id,
      "not-recorded",
      "unknown",
      "no patch is recorded to compare against the change-set record",
      [recordEv("changes", record, ""), manifestEv("", "no patch.diff entry")],
    );
  if (run.patch === null)
    return fact(
      id,
      "unverifiable",
      run.patchEntryTruncated ? "partial" : "unknown",
      `the patch is ${run.patchState}; its recorded paths cannot be ` +
        "checked against changes.json",
      [
        recordEv("changes", record, ""),
        artifactEv("patch", run, run.patchEntryIndex),
      ],
    );

  const doc = record.document!;
  const isStringList = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!CHANGE_KINDS.every((kind) => isStringList(doc[kind])))
    return fact(
      id,
      "unverifiable",
      "unknown",
      "the verified changes.json does not carry the documented " +
        "per-kind path lists; it cannot be compared against the patch",
      [recordEv("changes", record, "")],
    );
  const patch = run.patch;
  const sets: Record<(typeof CHANGE_KINDS)[number], Set<string>> = {
    added: new Set(doc.added as string[]),
    modified: new Set(doc.modified as string[]),
    deleted: new Set(doc.deleted as string[]),
  };
  const evidence = (): AuditEvidenceReference[] => [
    recordEv("changes", record, ""),
    artifactEv("patch", run, run.patchEntryIndex!),
  ];
  for (const kind of CHANGE_KINDS) {
    const patched = patch.files.filter((f) => f.change === kind);
    const missing = patched.find((f) => !sets[kind].has(f.path));
    if (missing !== undefined)
      return fact(
        id,
        "inconsistent",
        "complete",
        `patch.diff records a ${kind} change for '${missing.path}' that ` +
          "the verified changes.json does not list",
        evidence(),
      );
    if (
      run.patchRecord?.state === "complete" &&
      patched.length !== sets[kind].size
    )
      return fact(
        id,
        "inconsistent",
        "complete",
        `patch.state 'complete' contradicts the ${kind} set in the ` +
          "verified changes.json that patch.diff does not cover",
        evidence(),
      );
  }
  const partial =
    run.patchRecord?.state !== "complete" ||
    run.patchEntryTruncated ||
    patch.complete === false;
  return fact(
    id,
    "verified",
    partial ? "partial" : "complete",
    partial
      ? "every parsed patch block names a path the verified " +
          "changes.json lists under its kind; a partial patch may " +
          "cover a subset"
      : "the parsed patch and the verified changes.json record the " +
          "same per-kind change sets",
    evidence(),
  );
}

// -- result facts -------------------------------------------------------------

function auditResultAvailability(run: AuditedRun): AuditFact {
  const id = "result.availability";
  const entry = run.resultEntryIndex;
  const diagnostic = run.resultDiagnosticIndex;
  if (entry !== null && diagnostic !== -1)
    return fact(
      id,
      "inconsistent",
      "complete",
      "the trace's result diagnostic asserts no result was stored " +
        "while the manifest lists a result.txt entry",
      [diagnosticEv(diagnostic), entryEv(entry)],
    );
  if (entry !== null) {
    const state = run.entries[entry].state;
    return fact(
      id,
      "verified",
      state === "verified-truncated" ? "partial" : "complete",
      `the manifest records result.txt (${state}) and no result ` +
        "diagnostic contradicts it",
      [entryEv(entry)],
    );
  }
  if (diagnostic !== -1)
    return fact(
      id,
      "verified",
      "complete",
      "the trace's result diagnostic and the absent manifest entry " +
        "agree that no result was stored",
      [diagnosticEv(diagnostic), manifestEv("", "no result.txt entry")],
    );
  return fact(
    id,
    "not-recorded",
    "unknown",
    "neither the manifest nor the trace's diagnostics record a final " +
      "result",
    [
      manifestEv("", "no result.txt entry"),
      traceEv("", "no result diagnostic"),
    ],
  );
}

function auditResultContent(run: AuditedRun): AuditFact {
  const id = "result.content";
  const entry = run.resultEntryIndex;
  if (entry === null)
    return fact(
      id,
      "not-recorded",
      "unknown",
      "the manifest records no result.txt entry",
      [manifestEv("", "no result.txt entry")],
    );
  const state = run.entries[entry].state;
  const verifiedBytes = state === "verified" || state === "verified-truncated";
  if (!verifiedBytes)
    return fact(
      id,
      "unverifiable",
      "unknown",
      `the result is ${state}; no verified bytes exist to decode`,
      [entryEv(entry)],
    );
  const bytes = run.resultBytes;
  const evidence: AuditEvidenceReference[] = [
    {
      ...artifactEv("result", run, entry),
      ...(bytes === null ? {} : { bytes: { start: 0, end: bytes.length } }),
    },
  ];
  const completeness: AuditCompleteness =
    state === "verified-truncated" ? "partial" : "complete";
  if (run.resultText === null)
    return fact(
      id,
      "inconsistent",
      completeness,
      "the verified result.txt bytes do not decode to the contract's " +
        "UTF-8 text",
      evidence,
    );
  return fact(
    id,
    "verified",
    completeness,
    "the verified result.txt bytes decode to text under the contract " +
      "normalization",
    evidence,
  );
}

// -- check-report facts -------------------------------------------------------

function reportDescriptor(
  loaded: LoadedCheckReport,
): AuditCheckReportDescriptor {
  return {
    label: loaded.label,
    document: "check-report",
    evaluatorId: loaded.report?.evaluatorId ?? null,
    ...(loaded.report?.evaluatorVersion === undefined
      ? {}
      : { evaluatorVersion: loaded.report.evaluatorVersion }),
    state: loaded.report === null ? "invalid" : "parsed",
    ...(loaded.error === null ? {} : { error: loaded.error }),
    resultCount: loaded.report?.results.length ?? 0,
  };
}

/** The five per-report facts of docs/v0.8-scope.md. */
function auditCheckReportFacts(
  run: AuditedRun,
  loaded: LoadedCheckReport,
): AuditFact[] {
  const label = loaded.label;
  const report = loaded.report;
  const f = (
    suffix: string,
    state: AuditFact["state"],
    completeness: AuditCompleteness,
    reason: string,
    evidence: AuditEvidenceReference[],
  ) =>
    fact(
      `check-report.${suffix}`,
      state,
      completeness,
      reason,
      evidence,
      label,
    );

  const facts: AuditFact[] = [];
  if (report === null) {
    facts.push(
      f(
        "shape",
        "inconsistent",
        "unknown",
        `the supplied document is not a conforming check report: ` +
          (loaded.error ?? "could not be parsed"),
        [reportEv(label, "")],
      ),
    );
    for (const suffix of [
      "task-binding",
      "baseline-binding",
      "patch-binding",
      "results",
    ] as const)
      facts.push(
        f(
          suffix,
          "unverifiable",
          "unknown",
          "the report is not a conforming check report; its " +
            "declarations cannot be checked",
          [reportEv(label, "")],
        ),
      );
    return facts;
  }

  facts.push(
    f(
      "shape",
      "verified",
      "complete",
      "the supplied document is a conforming v1 check report",
      [reportEv(label, "")],
    ),
  );

  const taskMatch = report.taskDigest === run.trace.task.digest;
  facts.push(
    taskMatch
      ? f(
          "task-binding",
          "verified",
          "complete",
          `the declared subject.taskDigest matches the run's task.digest; ` +
            SELF_DECLARED,
          [reportEv(label, "/subject/taskDigest"), traceEv("/task/digest")],
        )
      : f(
          "task-binding",
          "inconsistent",
          "complete",
          `the declared subject.taskDigest does not match the run's ` +
            "task.digest",
          [reportEv(label, "/subject/taskDigest"), traceEv("/task/digest")],
        ),
  );

  if (report.baselineDigest === undefined) {
    facts.push(
      f(
        "baseline-binding",
        "not-recorded",
        "complete",
        "the report declares no subject.baselineDigest",
        [reportEv(label, "/subject")],
      ),
    );
  } else if (!run.seeded) {
    facts.push(
      f(
        "baseline-binding",
        "inconsistent",
        "complete",
        "the report declares a baseline digest but the run records no " +
          "seed",
        [
          reportEv(label, "/subject/baselineDigest"),
          traceEv("", "no seed field"),
        ],
      ),
    );
  } else {
    const expected = run.trace.seed!.baseline.requestedDigest;
    const matches = report.baselineDigest === expected;
    facts.push(
      matches
        ? f(
            "baseline-binding",
            "verified",
            "complete",
            `the declared subject.baselineDigest matches the run's ` +
              `requested baseline digest; ${SELF_DECLARED}`,
            [
              reportEv(label, "/subject/baselineDigest"),
              traceEv("/seed/baseline/requested_digest"),
            ],
          )
        : f(
            "baseline-binding",
            "inconsistent",
            "complete",
            `the declared subject.baselineDigest does not match the ` +
              "run's requested baseline digest",
            [
              reportEv(label, "/subject/baselineDigest"),
              traceEv("/seed/baseline/requested_digest"),
            ],
          ),
    );
  }

  if (report.patchDigest === undefined) {
    facts.push(
      f(
        "patch-binding",
        "not-recorded",
        "complete",
        "the report declares no subject.patchDigest",
        [reportEv(label, "/subject")],
      ),
    );
  } else if (run.patchEntryIndex === null) {
    facts.push(
      f(
        "patch-binding",
        "unverifiable",
        "unknown",
        "the run records no patch.diff entry to check the declared " +
          "digest against",
        [
          reportEv(label, "/subject/patchDigest"),
          manifestEv("", "no patch.diff entry"),
        ],
      ),
    );
  } else {
    const entry = run.entries[run.patchEntryIndex];
    const verified =
      entry.state === "verified" || entry.state === "verified-truncated";
    if (!verified) {
      facts.push(
        f(
          "patch-binding",
          "unverifiable",
          "unknown",
          `the run's patch.diff is ${entry.state}; the declared digest ` +
            "cannot be checked",
          [
            reportEv(label, "/subject/patchDigest"),
            entryEv(run.patchEntryIndex),
          ],
        ),
      );
    } else {
      const matches = entry.digest === report.patchDigest;
      facts.push(
        matches
          ? f(
              "patch-binding",
              "verified",
              "complete",
              `the declared subject.patchDigest matches the run's ` +
                `verified patch.diff digest; ${SELF_DECLARED}`,
              [
                reportEv(label, "/subject/patchDigest"),
                entryEv(run.patchEntryIndex),
              ],
            )
          : f(
              "patch-binding",
              "inconsistent",
              "complete",
              `the declared subject.patchDigest does not match the ` +
                "run's verified patch.diff digest",
              [
                reportEv(label, "/subject/patchDigest"),
                entryEv(run.patchEntryIndex),
              ],
            ),
      );
    }
  }

  // Rows are self-declared verdicts — never a pass/fail judgement here.
  // Identical duplicate criterionId rows are a reported limitation;
  // conflicting duplicates are a contradiction inside the report.
  const byId = new Map<string, { verdicts: Set<string>; count: number }>();
  for (const row of report.results) {
    const group = byId.get(row.criterionId) ?? {
      verdicts: new Set<string>(),
      count: 0,
    };
    group.verdicts.add(row.verdict);
    group.count += 1;
    byId.set(row.criterionId, group);
  }
  const conflicting = [...byId.keys()].find(
    (id) => byId.get(id)!.verdicts.size > 1,
  );
  const duplicates = [...byId.entries()].filter(([, g]) => g.count > 1);
  if (conflicting !== undefined) {
    facts.push(
      f(
        "results",
        "inconsistent",
        "complete",
        `the report records conflicting verdicts for '${conflicting}'; ` +
          "rows are self-declared and never execution evidence",
        [reportEv(label, "/results")],
      ),
    );
  } else {
    facts.push(
      f(
        "results",
        "verified",
        "complete",
        `the report records ${report.results.length} result row(s)` +
          (duplicates.length === 0
            ? ""
            : `; ${duplicates.length} criterion id(s) carry identical ` +
              "duplicate rows, preserved as a reported limitation") +
          `; rows are self-declared verdicts — ${SELF_DECLARED}`,
        [reportEv(label, "/results")],
      ),
    );
  }
  return facts;
}

/**
 * Audits one already-loaded run directory (docs/v0.8-scope.md): emits the
 * fixed fact list for the trace/manifest/seeded records, patch, and result,
 * plus the per-report binding facts for each supplied check report. Pure —
 * callers must load the run with `readAuditedRun` and the reports with
 * `loadCheckReports` first.
 */
export function auditRun(input: {
  run: AuditedRun;
  checkReports?: readonly LoadedCheckReport[];
  labels?: { run?: string };
}): AuditResult {
  const run = input.run;
  const reports = input.checkReports ?? [];
  const facts: AuditFact[] = [
    ...auditRunDocuments(),
    ...auditSeedFacts(run),
    ...auditBaselineManifest(run),
    ...auditChanges(run),
    storedFact(
      "patch.stored",
      run,
      run.patchEntryIndex,
      "patch.diff",
      "the manifest records no patch.diff entry",
    ),
    auditPatchInterpretable(run),
    auditPatchRecord(run),
    auditPatchCompleteness(run),
    auditSeedChangesPatch(run),
    auditChangesPatchAgreement(run),
    storedFact(
      "result.stored",
      run,
      run.resultEntryIndex,
      "result.txt",
      "the manifest records no result.txt entry",
    ),
    auditResultAvailability(run),
    auditResultContent(run),
    ...reports.flatMap((loaded) => auditCheckReportFacts(run, loaded)),
  ];

  if (facts.length > MAX_EMITTED_CLAIMS)
    throw new PflExportError(
      "invalid-shape",
      `audit would emit ${facts.length} facts, exceeding the ` +
        `${MAX_EMITTED_CLAIMS} ceiling`,
    );
  const evidenceCount = facts.reduce((t, f) => t + f.evidence.length, 0);
  if (evidenceCount > MAX_EVIDENCE_REFERENCES)
    throw new PflExportError(
      "invalid-shape",
      `audit would cite ${evidenceCount} evidence references, exceeding ` +
        `the ${MAX_EVIDENCE_REFERENCES} ceiling`,
    );

  const result: AuditResult = {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    source: { command: "audit-run" },
    inputs: {
      run: evaluationRunInput(run, input.labels?.run),
      checkReports: reports.map(reportDescriptor),
    },
    context: runContext(run),
    facts,
  };
  assertValidAuditResult(result);
  assertAuditEvidenceResolves(result, { run, checkReports: reports });
  return result;
}
