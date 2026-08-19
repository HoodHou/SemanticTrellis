import { TextDecoder } from "node:util";

export const SOURCE_TEXT_DECODER_VERSION = 2 as const;

function decodeUtf16Be(bytes: Buffer): string {
  const length = bytes.length - (bytes.length % 2);
  const swapped = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0;
    swapped[index + 1] = bytes[index] ?? 0;
  }
  return swapped.toString("utf16le");
}

function pythonEncoding(buffer: Buffer, path: string | undefined): string | null {
  if (path === undefined || !/\.pyi?$/i.test(path)) return null;
  const header = buffer.subarray(0, 512).toString("latin1").split(/\r?\n/).slice(0, 2).join("\n");
  const declared = header.match(/^[ \t\f]*#.*?coding[:=][ \t]*([-_.a-zA-Z0-9]+)/m)?.[1];
  if (declared === undefined) return null;
  const normalized = declared.toLowerCase().replace(/_/g, "-");
  if (normalized === "utf8" || normalized === "utf-8-sig") return "utf-8";
  return normalized;
}

function withoutUnicodeBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

export function decodeSourceText(bytes: Uint8Array, path?: string): string {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return decodeUtf16Be(buffer.subarray(2));
  }
  const encoding = pythonEncoding(buffer, path);
  if (encoding !== null) {
    if (new Set(["latin-1", "latin1", "iso-8859-1", "iso8859-1"]).has(encoding)) {
      return withoutUnicodeBom(buffer.toString("latin1"));
    }
    try {
      const decoderEncoding = encoding === "cp1252" ? "windows-1252" : encoding;
      return withoutUnicodeBom(new TextDecoder(decoderEncoding).decode(buffer));
    } catch {
      // Unknown legacy codecs fall back to UTF-8 and remain parser-visible.
    }
  }
  return withoutUnicodeBom(buffer.toString("utf8"));
}
