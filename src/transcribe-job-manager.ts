import { randomUUID } from "crypto";
import { rm } from "fs/promises";
import type {
  StructuredTranscriptionResult,
  SubtitleGenerator,
  WhisperEngineType,
} from "./subtitle-generator.js";

export interface AsyncTranscriptionContext {
  tempDir: string;
  workWavPath: string;
  originalBytes: number;
  language?: string;
  engine?: WhisperEngineType | "auto";
  skipCompression?: boolean;
}

type JobStatus = "processing" | "completed" | "failed" | "cancelled";

interface InternalJob {
  status: JobStatus;
  createdAt: number;
  cancelled: boolean;
  ctx: AsyncTranscriptionContext;
  result?: StructuredTranscriptionResult;
  error?: string;
}

const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Background async transcription jobs (long audio / explicit async flag).
 */
export class TranscribeJobManager {
  private jobs = new Map<string, InternalJob>();

  constructor(private readonly generator: SubtitleGenerator) {}

  enqueueAndStart(ctx: AsyncTranscriptionContext): string {
    const id = randomUUID();
    this.jobs.set(id, {
      status: "processing",
      createdAt: Date.now(),
      cancelled: false,
      ctx,
    });
    queueMicrotask(() => void this.run(id));
    return id;
  }

  private async run(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;

    if (job.cancelled) {
      job.status = "cancelled";
      await rm(job.ctx.tempDir, { recursive: true, force: true }).catch(
        () => {},
      );
      return;
    }

    try {
      const result = await this.generator.transcribeWorkWavWindowedStructured({
        workWavPath: job.ctx.workWavPath,
        originalBytes: job.ctx.originalBytes,
        language: job.ctx.language,
        engine: job.ctx.engine,
        skipCompression: job.ctx.skipCompression,
      });
      job.result = result;
      job.status = "completed";
    } catch (e) {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      await rm(job.ctx.tempDir, { recursive: true, force: true }).catch(
        () => {},
      );
    }
  }

  getJob(id: string): {
    status: JobStatus | "unknown";
    result?: StructuredTranscriptionResult;
    error?: string;
  } {
    this.gcOldJobs();
    const job = this.jobs.get(id);
    if (!job) return { status: "unknown", error: "Unknown job_id" };
    if (job.status === "processing") {
      return { status: "processing" };
    }
    if (job.status === "cancelled") {
      return { status: "cancelled", error: "Job was cancelled." };
    }
    if (job.status === "failed") {
      return { status: "failed", error: job.error || "Job failed." };
    }
    return { status: "completed", result: job.result };
  }

  cancelJob(id: string): { ok: boolean } {
    const job = this.jobs.get(id);
    if (!job) return { ok: false };
    job.cancelled = true;
    return { ok: true };
  }

  private gcOldJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (now - job.createdAt > JOB_RETENTION_MS) {
        this.jobs.delete(id);
      }
    }
  }
}
