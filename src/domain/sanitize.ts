/**
 * Characters that must never reach a terminal or claim text verbatim:
 * C0/C1 controls and DEL (escape sequences), zero-width and bidi formatting
 * characters (Trojan Source-style reordering), line/paragraph separators,
 * the BOM / zero-width no-break space, and the supplementary tag block.
 * In Unicode terms this is the general categories Cc, Cf, Zl, and Zp —
 * wider than the BMP-only ranges the original pattern covered, so it also
 * catches astral characters such as U+E0000–U+E007F language tags.
 *
 * Exported as a character class (no flags) so input validation and output
 * sanitization share one definition of unsafe text.
 */
export const UNSAFE_CHARACTER_CLASS = "\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}";

const UNSAFE_CHARACTERS = new RegExp(`[${UNSAFE_CHARACTER_CLASS}]`, "gu");

/** Escapes unsafe characters in external strings as literal `\uXXXX`. */
export function sanitizeText(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, (c) => {
    const codePoint = c.codePointAt(0)!;
    return codePoint <= 0xffff
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : `\\u{${codePoint.toString(16)}}`;
  });
}
