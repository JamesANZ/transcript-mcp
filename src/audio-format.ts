/**
 * Sniff audio container/codec from magic bytes (first 16 bytes).
 * If magic is inconclusive (`bin`), fall back to the filename extension hint.
 */

export type DetectedAudioFormat =
  | "ogg"
  | "mp3"
  | "wav"
  | "flac"
  | "webm"
  | "mp4"
  | "bin";

export function bytesToHex16(buf: Buffer): string {
  return buf.subarray(0, 16).toString("hex");
}

function extFromFilename(filename?: string): string | undefined {
  if (!filename || !filename.includes(".")) return undefined;
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext || undefined;
}

function hintToFormat(ext: string): DetectedAudioFormat | undefined {
  if (ext === "ogg" || ext === "opus") return "ogg";
  if (ext === "mp3") return "mp3";
  if (ext === "wav") return "wav";
  if (ext === "flac") return "flac";
  if (ext === "webm" || ext === "mkv") return "webm";
  if (ext === "mp4" || ext === "m4a" || ext === "aac") return "mp4";
  return undefined;
}

function sniffMagic(buf: Buffer): DetectedAudioFormat {
  if (buf.length < 4) return "bin";

  if (buf.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
  if (buf.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
  if (buf.length >= 2) {
    const b0 = buf[0];
    const b1 = buf[1];
    if (b0 === 0xff && (b1 === 0xfb || b1 === 0xf3 || b1 === 0xf2)) return "mp3";
  }
  if (buf.length >= 12) {
    const riff = buf.subarray(0, 4).toString("ascii");
    const wave = buf.subarray(8, 12).toString("ascii");
    if (riff === "RIFF" && wave === "WAVE") return "wav";
  }
  if (buf.subarray(0, 4).toString("ascii") === "fLaC") return "flac";
  if (
    buf.length >= 4 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  ) {
    return "webm";
  }
  if (buf.length >= 8) {
    const ftyp = buf.subarray(4, 8).toString("ascii");
    if (ftyp === "ftyp") return "mp4";
  }

  return "bin";
}

export function detectAudioFormatFromBuffer(
  buf: Buffer,
  filenameHint?: string,
): DetectedAudioFormat {
  const magic = sniffMagic(buf);
  if (magic !== "bin") return magic;
  const ext = extFromFilename(filenameHint);
  return (ext && hintToFormat(ext)) || "bin";
}

export function formatDetectionFailedMessage(buf: Buffer): string {
  return `Could not detect audio format from magic bytes (first 16 hex: ${bytesToHex16(buf)}). Provide a correct filename extension as a hint, or use a standard container (WAV, MP3, FLAC, Ogg, WebM, MP4).`;
}
