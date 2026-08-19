export const SOURCE_TEXT_DECODER_VERSION = 1 as const;

function decodeUtf16Be(bytes: Buffer): string {
  const length = bytes.length - (bytes.length % 2);
  const swapped = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0;
    swapped[index + 1] = bytes[index] ?? 0;
  }
  return swapped.toString("utf16le");
}

export function decodeSourceText(bytes: Uint8Array): string {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return decodeUtf16Be(buffer.subarray(2));
  }
  const text = buffer.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
