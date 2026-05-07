import { randomUUID } from "crypto";
import { mkdir, writeFile, readFile, rm, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export const DEFAULT_MAX_CHUNK_BYTES = 60 * 1024; // 60 KB raw (~80 KB base64)
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface UploadSession {
  id: string;
  dir: string;
  filename: string;
  expectedChunks: number;
  maxChunkBytes: number;
  language?: string;
  includeTimestamps: boolean;
  createdAt: number;
  received: Set<number>;
}

export class UploadSessionManager {
  private sessions = new Map<string, UploadSession>();
  private gcTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.gcTimer = setInterval(() => this.gcStaleSessions(), 10 * 60 * 1000);
    this.gcTimer.unref?.();
  }

  dispose(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
  }

  async createSession(params: {
    filename: string;
    expectedChunks: number;
    maxChunkBytes?: number;
    language?: string;
    includeTimestamps?: boolean;
  }): Promise<{ session: UploadSession; uploadId: string; maxChunkBytes: number }> {
    const maxChunkBytes = params.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    const uploadId = randomUUID();
    const dir = join(tmpdir(), `transcribe-upload-${uploadId}`);
    await mkdir(dir, { recursive: true });

    const session: UploadSession = {
      id: uploadId,
      dir,
      filename: params.filename,
      expectedChunks: params.expectedChunks,
      maxChunkBytes,
      language: params.language,
      includeTimestamps: params.includeTimestamps ?? true,
      createdAt: Date.now(),
      received: new Set(),
    };
    this.sessions.set(uploadId, session);
    return { session, uploadId, maxChunkBytes };
  }

  getSession(uploadId: string): UploadSession | undefined {
    return this.sessions.get(uploadId);
  }

  async appendChunk(
    uploadId: string,
    chunkIndex: number,
    audioBase64: string,
  ): Promise<{ received: number; expected: number }> {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Unknown upload_id: ${uploadId}`);
    }
    if (chunkIndex < 0 || chunkIndex >= session.expectedChunks) {
      throw new Error(
        `chunk_index ${chunkIndex} out of range (expected 0..${session.expectedChunks - 1}).`,
      );
    }

    const bytes = Buffer.from(audioBase64, "base64");
    if (bytes.length === 0) {
      throw new Error("audio_base64 decoded to an empty chunk.");
    }
    if (bytes.length > session.maxChunkBytes) {
      throw new Error(
        `Chunk is ${bytes.length} bytes; max_chunk_bytes is ${session.maxChunkBytes}. Split into smaller chunks.`,
      );
    }

    const chunkPath = join(session.dir, `chunk-${String(chunkIndex).padStart(6, "0")}.bin`);
    await writeFile(chunkPath, bytes);
    session.received.add(chunkIndex);

    return {
      received: session.received.size,
      expected: session.expectedChunks,
    };
  }

  async readConcatenated(uploadId: string): Promise<Buffer> {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new Error(`Unknown upload_id: ${uploadId}`);
    }
    if (session.received.size !== session.expectedChunks) {
      throw new Error(
        `Missing chunks: received ${session.received.size} of ${session.expectedChunks}. Append all chunks before finalize.`,
      );
    }

    const parts: Buffer[] = [];
    for (let i = 0; i < session.expectedChunks; i++) {
      const chunkPath = join(session.dir, `chunk-${String(i).padStart(6, "0")}.bin`);
      parts.push(await readFile(chunkPath));
    }
    return Buffer.concat(parts);
  }

  async finalizeAndRemove(uploadId: string): Promise<void> {
    const session = this.sessions.get(uploadId);
    if (!session) return;
    this.sessions.delete(uploadId);
    await rm(session.dir, { recursive: true, force: true }).catch(() => {});
  }

  private async gcStaleSessions(): Promise<void> {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) {
        this.sessions.delete(id);
        await rm(s.dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /** Test helper: list temp dirs matching prefix (not used in prod). */
  async debugListChunkFiles(uploadId: string): Promise<string[]> {
    const s = this.sessions.get(uploadId);
    if (!s) return [];
    const names = await readdir(s.dir);
    return names.sort();
  }
}
