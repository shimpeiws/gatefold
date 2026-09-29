/**
 * The declared source-project identity contract shared by yuurei (#214 —
 * trace `seed.source_project`) and pfl (#217 — export
 * `data.snapshot.sourceProject`). The identity is caller-declared
 * provenance: `git-<hex16>` over the normalized remote URL or
 * `path-<hex16>` over the canonical source root, asserted by the seeding
 * tool and carried inside the observed export — never derived or verified
 * by Gatefold itself. Bounds mirror the values pfl validates at both its
 * write and read paths so a record pfl would never persist is rejected
 * here as well.
 */
import { UNSAFE_CHARACTER_CLASS } from "../domain/sanitize.js";

export const SOURCE_PROJECT_KINDS = ["git-remote", "local-path"] as const;

export type SourceProjectKind = (typeof SOURCE_PROJECT_KINDS)[number];

/**
 * `id`'s prefix encodes which derivation `kind` claims (`git-` for
 * `git-remote`, `path-` for `local-path`); a declaration whose two halves
 * disagree is self-contradictory.
 */
export const SOURCE_PROJECT_ID_PREFIXES: Record<SourceProjectKind, string> = {
  "git-remote": "git-",
  "local-path": "path-",
};

/** The `hashedProjectId` shape pfl holds a declared identity to. */
export const SOURCE_PROJECT_ID_PATTERN = /^(git|path)-[0-9a-f]{16}$/;

export const SOURCE_PROJECT_ISSUER_MAX_CHARS = 64;
export const SOURCE_PROJECT_REMOTE_MAX_CHARS = 512;
export const SOURCE_PROJECT_HEAD_MAX_CHARS = 128;

/**
 * Asserted free text must not carry C0/C1 controls, DEL, or invisible
 * formatting characters — the values are echoed in reports, where escapes
 * could inject terminal sequences or reorder output. The class is shared
 * with domain/sanitize.ts so validation and display escaping agree.
 */
export const SOURCE_PROJECT_CONTROL_CHARS_PATTERN = new RegExp(
  `[${UNSAFE_CHARACTER_CLASS}]`,
  "u",
);

/** The only declaration contract version pfl writes and reads. */
export const SOURCE_PROJECT_CONTRACT_VERSION = 1;
