import { Buffer } from "node:buffer";

/**
 * Compares two strings by UTF-8 byte order, the order the result contract
 * requires for usage keys, caveat fields, and evidence pointers.
 *
 * JavaScript's default string comparison orders by UTF-16 code unit, which
 * differs for characters outside the Basic Multilingual Plane: U+10000 sorts
 * before U+FFFD by code unit but after it by UTF-8 byte.
 */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
