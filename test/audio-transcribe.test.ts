/**
 * Audio ingestion / transcription helper tests (no OpenAI calls).
 */

import {
  detectAudioFormatFromBuffer,
  bytesToHex16,
} from "../src/audio-format.js";
import { fetchAudioFromUrl } from "../src/audio-url-fetch.js";
import { getConfig } from "../src/config.js";
import { UploadSessionManager } from "../src/upload-session-manager.js";
import {
  SubtitleGenerator,
  TRANSCRIBE_SINGLE_CALL_MAX_BYTES,
} from "../src/subtitle-generator.js";

describe("audio format detection", () => {
  it("detects Ogg/Opus from magic even if filename says .mp3", () => {
    const buf = Buffer.from("OggS" + "x".repeat(12));
    expect(detectAudioFormatFromBuffer(buf, "voice.mp3")).toBe("ogg");
  });

  it("falls back to filename extension when magic is inconclusive", () => {
    const buf = Buffer.alloc(16, 0);
    expect(detectAudioFormatFromBuffer(buf, "hint.wav")).toBe("wav");
  });

  it("includes hex prefix in format failure helper", () => {
    const buf = Buffer.alloc(16, 0);
    expect(bytesToHex16(buf)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("audio_url allowlist", () => {
  it("blocks fetches when allowlist is empty", async () => {
    const cfg = getConfig();
    cfg.transcriptMcpUrlAllowlist = "";
    await expect(
      fetchAudioFromUrl("https://example.com/a.mp3", cfg),
    ).rejects.toThrow(/TRANSCRIPT_MCP_URL_ALLOWLIST is empty/i);
  });

  it("blocks non-matching hosts", async () => {
    const cfg = getConfig();
    cfg.transcriptMcpUrlAllowlist = "localhost";
    await expect(
      fetchAudioFromUrl("https://evil.com/a.mp3", cfg),
    ).rejects.toThrow(/not allowed/i);
  });
});

describe("single-call base64 size limit", () => {
  it("rejects payloads larger than TRANSCRIBE_SINGLE_CALL_MAX_BYTES", async () => {
    const gen = new SubtitleGenerator(getConfig());
    const big = Buffer.alloc(TRANSCRIBE_SINGLE_CALL_MAX_BYTES + 1, 7).toString(
      "base64",
    );
    await expect(
      gen.transcribeAudioStructured(
        {
          audioBase64: big,
          filename: "big.bin",
        },
        undefined,
      ),
    ).rejects.toThrow(/max single-call size/i);
  });
});

describe("path materialization errors", () => {
  it("includes sandbox guidance when a local path is missing", async () => {
    const gen = new SubtitleGenerator(getConfig());
    await expect(
      gen.transcribeAudioStructured(
        { audioPath: "/no/such/file/zzzz-audio.bin" },
        undefined,
      ),
    ).rejects.toThrow(/sandboxed host/i);
  });
});

describe("chunked upload session", () => {
  it("enforces max chunk size", async () => {
    const mgr = new UploadSessionManager();
    const { uploadId, maxChunkBytes } = await mgr.createSession({
      filename: "x.bin",
      expectedChunks: 2,
    });
    const tooBig = Buffer.alloc(maxChunkBytes + 1, 1).toString("base64");
    await expect(mgr.appendChunk(uploadId, 0, tooBig)).rejects.toThrow(
      /max_chunk_bytes/i,
    );
    await mgr.finalizeAndRemove(uploadId);
  });

  it("concatenates chunks in index order", async () => {
    const mgr = new UploadSessionManager();
    const { uploadId } = await mgr.createSession({
      filename: "c.bin",
      expectedChunks: 2,
    });
    await mgr.appendChunk(uploadId, 1, Buffer.from("B").toString("base64"));
    await mgr.appendChunk(uploadId, 0, Buffer.from("A").toString("base64"));
    const out = await mgr.readConcatenated(uploadId);
    expect(out.toString("utf8")).toBe("AB");
    await mgr.finalizeAndRemove(uploadId);
  });
});
