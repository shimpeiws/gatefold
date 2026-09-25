/**
 * Characters that must never reach a terminal or claim text verbatim:
 * C0/C1 controls and DEL (escape sequences), zero-width and bidi formatting
 * characters (Trojan Source-style reordering), line/paragraph separators, and
 * the BOM / zero-width no-break space.
 */
const UNSAFE_CHARACTERS =
  /[\x00-\x1F\x7F-\x9F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

/** Escapes unsafe characters in external strings as literal `\uXXXX`. */
export function sanitizeText(text: string): string {
  return text.replace(
    UNSAFE_CHARACTERS,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
