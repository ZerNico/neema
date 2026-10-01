// Loaded by the Word worker under plain Node in development: relative imports only.

/** A picture's type and pixel size from its own bytes; anything but PNG or JPEG is refused. */
export function pictureOf(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a)
    return { mediaType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 4 && view.getUint16(0) === 0xffd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1]!;
      const length = view.getUint16(at + 2);
      // Start-of-frame markers carry the size; C4, C8 and CC share the range but don't.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return {
          mediaType: "image/jpeg",
          width: view.getUint16(at + 7),
          height: view.getUint16(at + 5),
        };
      at += 2 + length;
    }
  }
  return null;
}
