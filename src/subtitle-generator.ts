/**
 * Subtitle generator using OpenAI Whisper API or local whisper.cpp
 */

import { exec } from "child_process";
import { promisify } from "util";
import { join, dirname, basename, resolve } from "path";
import {
  mkdtemp,
  readFile,
  writeFile,
  unlink,
  stat,
  copyFile,
  rm,
} from "fs/promises";
import { createReadStream } from "fs";
import { tmpdir } from "os";
import OpenAI from "openai";
import { Config, detectWhisperEngine, checkToolAvailable } from "./config.js";
import {
  detectAudioFormatFromBuffer,
  formatDetectionFailedMessage,
} from "./audio-format.js";
import { fetchAudioFromUrl } from "./audio-url-fetch.js";
import {
  buildTranscriptionWindows,
  extractWavSegment,
} from "./audio-silence.js";
import type { TranscribeJobManager } from "./transcribe-job-manager.js";

const execAsync = promisify(exec);

async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

/** Max raw bytes for single-shot `audio_base64` on `transcribe-audio` (use chunked upload above this). */
export const TRANSCRIBE_SINGLE_CALL_MAX_BYTES = 60 * 1024;

const ASYNC_JOB_DURATION_THRESHOLD_S = 300;
const WINDOW_TRANSCRIBE_CONCURRENCY = 3;

export type SubtitleFormat = "srt" | "vtt";
export type WhisperEngineType = "openai" | "local";

export interface SubtitleOptions {
  videoPath: string;
  engine?: WhisperEngineType;
  language?: string;
  outputFormat?: SubtitleFormat;
  outputPath?: string;
}

export interface SubtitleResult {
  subtitlePath: string;
  language: string;
  duration: number;
  engine: WhisperEngineType;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  confidence?: number;
}

export interface AudioTranscriptionOptions {
  audioPath?: string;
  audioBase64?: string;
  audioResourceUri?: string;
  /** HTTP(S) URL fetched by the MCP server (requires TRANSCRIPT_MCP_URL_ALLOWLIST). */
  audioUrl?: string;
  filename?: string;
  language?: string;
  engine?: WhisperEngineType | "auto";
  /** When true, skip Opus recompression (still decodes to WAV for local whisper when needed). */
  skipCompression?: boolean;
  /** When true, return immediately with job id for long/async transcription (handled by server). */
  async?: boolean;
  /** Internal: bypass single-call base64 size cap (chunked finalize). */
  _allowLargeBase64?: boolean;
}

export interface AudioTranscriptionResult {
  transcript: string;
  language: string;
  duration: number;
  engine: WhisperEngineType;
  segments: TranscriptionSegment[];
}

export interface StructuredTranscriptionSegment {
  start: number;
  end: number;
  text: string;
  /** Rough confidence when the backend exposes log-prob information. */
  confidence?: number;
}

export interface StructuredTranscriptionResult {
  text: string;
  segments: StructuredTranscriptionSegment[];
  language: string;
  duration_s: number;
  engine: string;
  compressed_bytes: number;
  original_bytes: number;
}

export interface TranscribeAsyncQueued {
  job_id: string;
  status: "processing";
}

export class SubtitleGenerator {
  private config: Config;
  private debug: boolean;
  private openai?: OpenAI;

  constructor(config: Config) {
    this.config = config;
    this.debug = config.debug;

    if (config.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.error("[subtitle-generator]", ...args);
    }
  }

  /**
   * Generate subtitles for a video file
   */
  async generateSubtitles(options: SubtitleOptions): Promise<SubtitleResult> {
    const { videoPath, language, outputFormat = "srt", outputPath } = options;

    // Verify video file exists
    try {
      await stat(videoPath);
    } catch {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    // Determine which engine to use
    let engine = options.engine;
    if (!engine) {
      const detectedEngine = await detectWhisperEngine(this.config);
      if (!detectedEngine) {
        throw new Error(
          "No Whisper engine available. Set OPENAI_API_KEY for OpenAI Whisper or install whisper locally.",
        );
      }
      engine = detectedEngine;
    }

    this.log(`Using ${engine} engine for subtitle generation`);

    // Determine output path
    const videoBasename = basename(
      videoPath,
      videoPath.substring(videoPath.lastIndexOf(".")),
    );
    const subtitleFilename = `${videoBasename}.${outputFormat}`;
    const subtitlePath =
      outputPath || join(dirname(videoPath), subtitleFilename);

    // Extract audio from video
    const audioPath = await this.extractAudio(videoPath);

    try {
      let segments: TranscriptionSegment[];
      let detectedLanguage = language || "en";

      if (engine === "openai") {
        const result = await this.transcribeWithOpenAI(audioPath, language);
        segments = result.segments;
        detectedLanguage = result.language;
      } else {
        const result = await this.transcribeWithLocalWhisper(
          audioPath,
          language,
        );
        segments = result.segments;
        detectedLanguage = result.language;
      }

      // Generate subtitle file
      const subtitleContent =
        outputFormat === "srt"
          ? this.generateSRT(segments)
          : this.generateVTT(segments);

      await writeFile(subtitlePath, subtitleContent, "utf-8");

      // Get video duration
      const duration = await this.getVideoDuration(videoPath);

      return {
        subtitlePath,
        language: detectedLanguage,
        duration,
        engine,
      };
    } finally {
      // Clean up temporary audio file
      await unlink(audioPath).catch(() => {});
    }
  }

  async transcribeAudio(
    options: AudioTranscriptionOptions,
  ): Promise<AudioTranscriptionResult> {
    const structured = await this.transcribeAudioStructured(options, undefined);
    if ("job_id" in structured) {
      throw new Error(
        "Async transcription was requested; use transcribe_get_job with the returned job_id.",
      );
    }
    const engine: WhisperEngineType =
      structured.engine === "local-whisper" ? "local" : "openai";
    return {
      transcript: structured.text,
      language: structured.language,
      duration: structured.duration_s,
      engine,
      segments: structured.segments.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })),
    };
  }

  /**
   * Transcribe from an already-materialized file on disk (e.g. chunked upload finalize).
   */
  async transcribeAudioFromFilePath(
    absolutePath: string,
    opts: {
      language?: string;
      engine?: WhisperEngineType | "auto";
      skipCompression?: boolean;
      filenameHint?: string;
      async?: boolean;
    },
    jobQueue?: TranscribeJobManager,
  ): Promise<StructuredTranscriptionResult | TranscribeAsyncQueued> {
    const tempDir = await mkdtemp(join(tmpdir(), "video-toolkit-audio-"));
    const materialized = join(tempDir, basename(absolutePath));
    await copyFile(absolutePath, materialized);
    return await this.runStructuredPipelineInDir(
      tempDir,
      materialized,
      {
        ...opts,
        filenameHint: opts.filenameHint || basename(absolutePath),
        _allowLargeBase64: true,
      },
      jobQueue,
    );
  }

  /**
   * Full transcription pipeline with compression, optional async job for long audio,
   * and structured output.
   */
  async transcribeAudioStructured(
    options: AudioTranscriptionOptions,
    jobQueue?: TranscribeJobManager,
  ): Promise<StructuredTranscriptionResult | TranscribeAsyncQueued> {
    const tempDir = await mkdtemp(join(tmpdir(), "video-toolkit-audio-"));
    try {
      const materialized = await this.materializeAudioInput(options, tempDir);
      return await this.runStructuredPipelineInDir(
        tempDir,
        materialized,
        {
          language: options.language,
          engine: options.engine,
          skipCompression: options.skipCompression,
          async: options.async,
          filenameHint: options.filename,
          _allowLargeBase64: options._allowLargeBase64,
        },
        jobQueue,
      );
    } catch (e) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  private async runStructuredPipelineInDir(
    tempDir: string,
    materializedPath: string,
    opts: {
      language?: string;
      engine?: WhisperEngineType | "auto";
      skipCompression?: boolean;
      async?: boolean;
      filenameHint?: string;
      _allowLargeBase64?: boolean;
    },
    jobQueue?: TranscribeJobManager,
  ): Promise<StructuredTranscriptionResult | TranscribeAsyncQueued> {
    const head = await readFile(materializedPath).then((b) =>
      b.subarray(0, Math.min(16, b.length)),
    );
    const detected = detectAudioFormatFromBuffer(head, opts.filenameHint);
    let decodeInputPath = materializedPath;
    if (detected !== "bin") {
      const typedPath = join(tempDir, `input.${detected}`);
      if (typedPath !== materializedPath) {
        await copyFile(materializedPath, typedPath);
        decodeInputPath = typedPath;
      }
    }

    const originalStat = await stat(materializedPath);
    const originalBytes = originalStat.size;

    const workWav = join(tempDir, "work.wav");
    try {
      await this.normalizeAudio(decodeInputPath, workWav);
    } catch (e) {
      if (detected === "bin") {
        throw new Error(formatDetectionFailedMessage(head));
      }
      throw e;
    }

    const durationS = await this.getAudioDuration(workWav);
    const wantsAsync =
      Boolean(opts.async) || durationS > ASYNC_JOB_DURATION_THRESHOLD_S;

    if (wantsAsync) {
      if (jobQueue) {
        const jobId = jobQueue.enqueueAndStart({
          tempDir,
          workWavPath: workWav,
          originalBytes,
          language: opts.language,
          engine: opts.engine,
          skipCompression: opts.skipCompression,
        });
        return { job_id: jobId, status: "processing" };
      }

      const structured = await this.transcribeWorkWavWindowedStructured({
        workWavPath: workWav,
        originalBytes,
        language: opts.language,
        engine: opts.engine,
        skipCompression: opts.skipCompression,
      });
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return structured;
    }

    const whisperInput = await this.buildWhisperInputPath(
      tempDir,
      workWav,
      Boolean(opts.skipCompression),
    );

    const structured = await this.transcribeWhisperInputStructured({
      whisperInputPath: whisperInput.path,
      originalBytes,
      compressedBytes: whisperInput.compressedBytes,
      language: opts.language,
      engine: opts.engine,
      durationHint: durationS,
    });

    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return structured;
  }

  private async buildWhisperInputPath(
    tempDir: string,
    workWav: string,
    skipCompression: boolean,
  ): Promise<{ path: string; compressedBytes: number }> {
    if (skipCompression) {
      const st = await stat(workWav);
      return { path: workWav, compressedBytes: st.size };
    }
    const opusPath = join(tempDir, "compressed.opus");
    await this.compressToOpus(workWav, opusPath);
    const st = await stat(opusPath);
    return { path: opusPath, compressedBytes: st.size };
  }

  private async transcribeWhisperInputStructured(params: {
    whisperInputPath: string;
    originalBytes: number;
    compressedBytes: number;
    language?: string;
    engine?: WhisperEngineType | "auto";
    durationHint: number;
  }): Promise<StructuredTranscriptionResult> {
    const { selectedEngine, fallbackEngine } = await this.resolveTranscriptionEngines(
      params.engine,
    );
    const language = params.language;
    let selectedResult:
      | { segments: TranscriptionSegment[]; language: string }
      | undefined;
    let usedEngine: WhisperEngineType = selectedEngine;
    let primaryError: string | undefined;

    try {
      selectedResult =
        selectedEngine === "openai"
          ? await this.transcribeWithOpenAI(params.whisperInputPath, language)
          : await this.transcribeWithLocalWhisper(params.whisperInputPath, language);
    } catch (error) {
      primaryError = error instanceof Error ? error.message : String(error);
    }

    if (!selectedResult && fallbackEngine) {
      this.log(
        `Primary ${selectedEngine} transcription failed, trying ${fallbackEngine} fallback`,
      );
      selectedResult =
        fallbackEngine === "openai"
          ? await this.transcribeWithOpenAI(params.whisperInputPath, language)
          : await this.transcribeWithLocalWhisper(params.whisperInputPath, language);
      usedEngine = fallbackEngine;
    }

    if (!selectedResult) {
      throw new Error(
        primaryError || "Transcription failed and no fallback engine available.",
      );
    }

    const duration =
      params.durationHint ||
      (await this.getAudioDuration(params.whisperInputPath));

    const engineLabel =
      usedEngine === "openai" ? "openai-whisper-1" : "local-whisper";

    return {
      text: selectedResult.segments.map((s) => s.text).join(" "),
      segments: selectedResult.segments.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
        confidence: s.confidence,
      })),
      language: selectedResult.language,
      duration_s: duration,
      engine: engineLabel,
      compressed_bytes: params.compressedBytes,
      original_bytes: params.originalBytes,
    };
  }

  /** Used by async job runner: transcribe windowed mono WAV with stitched timestamps. */
  async transcribeWorkWavWindowedStructured(params: {
    workWavPath: string;
    originalBytes: number;
    language?: string;
    engine?: WhisperEngineType | "auto";
    skipCompression?: boolean;
  }): Promise<StructuredTranscriptionResult> {
    const windows = await buildTranscriptionWindows(
      this.config.ffmpegPath,
      this.config.ffprobePath,
      params.workWavPath,
    );

    const { selectedEngine, fallbackEngine } = await this.resolveTranscriptionEngines(
      params.engine,
    );

    const runEngine = async (
      engine: WhisperEngineType,
    ): Promise<{
      segments: TranscriptionSegment[];
      language: string;
      compressedTotal: number;
    }> => {
      const pieces: TranscriptionSegment[][] = new Array(windows.length);
      let detectedLang = params.language || "en";
      const compressedPerWindow = new Array<number>(windows.length);

      const tasks = windows.map((w, i) => ({ w, i }));

      await mapLimit(tasks, WINDOW_TRANSCRIBE_CONCURRENCY, async ({ w, i }) => {
        const segWav = join(
          dirname(params.workWavPath),
          `win-${String(i).padStart(4, "0")}.wav`,
        );
        await extractWavSegment(
          this.config.ffmpegPath,
          params.workWavPath,
          segWav,
          w.start,
          w.end,
        );

        const whisperInput = await this.buildWhisperInputPath(
          dirname(segWav),
          segWav,
          Boolean(params.skipCompression),
        );
        compressedPerWindow[i] = whisperInput.compressedBytes;

        let result:
          | { segments: TranscriptionSegment[]; language: string }
          | undefined;
        try {
          result =
            engine === "openai"
              ? await this.transcribeWithOpenAI(whisperInput.path, params.language)
              : await this.transcribeWithLocalWhisper(whisperInput.path, params.language);
        } finally {
          await unlink(segWav).catch(() => {});
          if (whisperInput.path !== segWav) {
            await unlink(whisperInput.path).catch(() => {});
          }
        }

        if (!result) {
          throw new Error("Empty transcription result for a window.");
        }
        detectedLang = result.language || detectedLang;
        pieces[i] = result.segments.map((s) => ({
          start: s.start + w.start,
          end: s.end + w.start,
          text: s.text,
        }));
      });

      const merged: TranscriptionSegment[] = [];
      for (let i = 0; i < windows.length; i++) {
        merged.push(...(pieces[i] || []));
      }

      const compressedTotal = compressedPerWindow.reduce((a, b) => a + (b || 0), 0);
      return { segments: merged, language: detectedLang, compressedTotal };
    };

    let primaryError: string | undefined;
    let usedEngine: WhisperEngineType = selectedEngine;
    let packed:
      | {
          segments: TranscriptionSegment[];
          language: string;
          compressedTotal: number;
        }
      | undefined;
    try {
      packed = await runEngine(selectedEngine);
    } catch (e) {
      primaryError = e instanceof Error ? e.message : String(e);
    }

    if (!packed && fallbackEngine) {
      usedEngine = fallbackEngine;
      packed = await runEngine(fallbackEngine);
    }

    if (!packed) {
      throw new Error(primaryError || "Windowed transcription failed.");
    }

    const duration = await this.getAudioDuration(params.workWavPath);

    const engineLabel =
      usedEngine === "openai" ? "openai-whisper-1" : "local-whisper";

    return {
      text: packed.segments.map((s) => s.text).join(" "),
      segments: packed.segments.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
        confidence: s.confidence,
      })),
      language: packed.language,
      duration_s: duration,
      engine: engineLabel,
      compressed_bytes: packed.compressedTotal,
      original_bytes: params.originalBytes,
    };
  }

  private async compressToOpus(inputPath: string, outputPath: string): Promise<void> {
    const command = [
      this.config.ffmpegPath,
      "-y",
      "-i",
      `"${inputPath}"`,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libopus",
      "-b:a",
      "16k",
      `"${outputPath}"`,
    ].join(" ");

    this.log(`Compressing audio to opus: ${command}`);
    try {
      await execAsync(command, { maxBuffer: 50 * 1024 * 1024 });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to compress audio to Opus (ffmpeg/libopus). Install a full ffmpeg build: ${msg}`,
      );
    }
  }

  /**
   * Extract audio from video using ffmpeg
   */
  private async extractAudio(videoPath: string): Promise<string> {
    const audioPath = videoPath.replace(/\.[^/.]+$/, ".wav");

    const command = [
      this.config.ffmpegPath,
      "-i",
      `"${videoPath}"`,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      `"${audioPath}"`,
    ].join(" ");

    this.log(`Extracting audio: ${command}`);

    try {
      await execAsync(command, { maxBuffer: 50 * 1024 * 1024 });
      return audioPath;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to extract audio: ${errorMessage}`);
    }
  }

  private async materializeAudioInput(
    options: AudioTranscriptionOptions,
    tempDir: string,
  ): Promise<string> {
    const providedInputs = [
      options.audioPath,
      options.audioBase64,
      options.audioResourceUri,
      options.audioUrl,
    ].filter(Boolean);

    if (providedInputs.length !== 1) {
      throw new Error(
        "Provide exactly one audio input: audio_path, audio_base64, audio_resource_uri, or audio_url.",
      );
    }

    if (options.audioPath) {
      const resolved = resolve(options.audioPath);
      await stat(resolved).catch(() => {
        throw new Error(
          `Audio file not found at resolved absolute path: ${resolved}\n` +
            `This MCP server reads paths from its own filesystem. If you're calling from a sandboxed host (Claude.ai, Claude Code), use audio_url, small audio_base64 payloads, or the chunked upload tools transcribe_upload_start / transcribe_upload_append / transcribe_upload_finalize instead.`,
        );
      });
      const pathFromName = options.filename || basename(resolved);
      const outputPath = join(tempDir, pathFromName);
      await copyFile(resolved, outputPath);
      return outputPath;
    }

    if (options.audioUrl) {
      const fetched = await fetchAudioFromUrl(options.audioUrl, this.config);
      const filename = options.filename || fetched.filenameHint || "audio-url.bin";
      const outputPath = join(tempDir, filename);
      await writeFile(outputPath, fetched.buffer);
      return outputPath;
    }

    if (options.audioBase64) {
      const bytes = Buffer.from(options.audioBase64, "base64");
      if (bytes.length === 0) {
        throw new Error("audio_base64 decoded to an empty payload.");
      }
      if (!options._allowLargeBase64 && bytes.length > TRANSCRIBE_SINGLE_CALL_MAX_BYTES) {
        throw new Error(
          `Payload is ${bytes.length} bytes; max single-call size is ${TRANSCRIBE_SINGLE_CALL_MAX_BYTES} bytes. Use transcribe_upload_start / transcribe_upload_append / transcribe_upload_finalize for files this large, or pass audio_url.`,
        );
      }
      const filename = options.filename || "audio-upload.bin";
      const outputPath = join(tempDir, filename);
      await writeFile(outputPath, bytes);
      return outputPath;
    }

    const uri = options.audioResourceUri as string;
    if (uri.startsWith("file://")) {
      const rawPath = uri.replace(/^file:\/\//, "");
      const filePath = decodeURIComponent(rawPath);
      const resolved = resolve(filePath);
      await stat(resolved).catch(() => {
        throw new Error(
          `Audio resource URI file not found at resolved absolute path: ${resolved}\n` +
            `This MCP server reads paths from its own filesystem. If you're calling from a sandboxed host (Claude.ai, Claude Code), use audio_url, small audio_base64 payloads, or the chunked upload tools transcribe_upload_start / transcribe_upload_append / transcribe_upload_finalize instead.`,
        );
      });
      const pathFromName = options.filename || basename(resolved);
      const outputPath = join(tempDir, pathFromName);
      await copyFile(resolved, outputPath);
      return outputPath;
    }

    if (uri.startsWith("data:")) {
      const match = uri.match(/^data:.*?;base64,(.+)$/);
      if (!match) {
        throw new Error(
          "Unsupported data URI format. Expected base64-encoded data URI.",
        );
      }
      const bytes = Buffer.from(match[1], "base64");
      if (bytes.length === 0) {
        throw new Error("audio_resource_uri data URI decoded to empty payload.");
      }
      if (!options._allowLargeBase64 && bytes.length > TRANSCRIBE_SINGLE_CALL_MAX_BYTES) {
        throw new Error(
          `Payload is ${bytes.length} bytes; max single-call size is ${TRANSCRIBE_SINGLE_CALL_MAX_BYTES} bytes. Use transcribe_upload_start / transcribe_upload_append / transcribe_upload_finalize for files this large, or pass audio_url.`,
        );
      }
      const filename = options.filename || "audio-resource.bin";
      const outputPath = join(tempDir, filename);
      await writeFile(outputPath, bytes);
      return outputPath;
    }

    throw new Error(
      "Unsupported audio_resource_uri scheme. Use file:// or data: URI.",
    );
  }

  private async normalizeAudio(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    const command = [
      this.config.ffmpegPath,
      "-i",
      `"${inputPath}"`,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-y",
      `"${outputPath}"`,
    ].join(" ");

    this.log(`Normalizing audio: ${command}`);

    try {
      await execAsync(command, { maxBuffer: 50 * 1024 * 1024 });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to normalize audio. Ensure ffmpeg supports this format: ${errorMessage}`,
      );
    }
  }

  /**
   * Get video duration using ffprobe
   */
  private async getVideoDuration(videoPath: string): Promise<number> {
    try {
      const command = `${this.config.ffprobePath} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`;
      const { stdout } = await execAsync(command);
      return parseFloat(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  private async getAudioDuration(audioPath: string): Promise<number> {
    try {
      const command = `${this.config.ffprobePath} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`;
      const { stdout } = await execAsync(command);
      return parseFloat(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  private async resolveTranscriptionEngines(
    requestedEngine?: WhisperEngineType | "auto",
  ): Promise<{
    selectedEngine: WhisperEngineType;
    fallbackEngine?: WhisperEngineType;
  }> {
    const availableEngines = await this.getAvailableEngines();
    if (availableEngines.length === 0) {
      throw new Error(
        "No transcription engine available. Set OPENAI_API_KEY or install local whisper.",
      );
    }

    if (requestedEngine === "openai") {
      if (!availableEngines.includes("openai")) {
        throw new Error(
          "Requested engine 'openai' is unavailable. Set OPENAI_API_KEY.",
        );
      }
      return {
        selectedEngine: "openai",
        fallbackEngine: availableEngines.includes("local") ? "local" : undefined,
      };
    }

    if (requestedEngine === "local") {
      if (!availableEngines.includes("local")) {
        throw new Error(
          "Requested engine 'local' is unavailable. Install local whisper.",
        );
      }
      return { selectedEngine: "local" };
    }

    const selectedEngine: WhisperEngineType = availableEngines.includes("openai")
      ? "openai"
      : "local";
    const fallbackEngine: WhisperEngineType | undefined =
      selectedEngine === "openai" && availableEngines.includes("local")
        ? "local"
        : undefined;

    return { selectedEngine, fallbackEngine };
  }

  /**
   * Transcribe audio using OpenAI Whisper API
   */
  private async transcribeWithOpenAI(
    audioPath: string,
    language?: string,
  ): Promise<{ segments: TranscriptionSegment[]; language: string }> {
    if (!this.openai) {
      throw new Error("OpenAI client not initialized. Set OPENAI_API_KEY.");
    }

    this.log(`Transcribing with OpenAI Whisper: ${audioPath}`);

    try {
      const transcription = await this.openai.audio.transcriptions.create({
        file: createReadStream(audioPath),
        model: "whisper-1",
        response_format: "verbose_json",
        language: language,
        timestamp_granularities: ["segment"],
      });

      const segments: TranscriptionSegment[] = (
        transcription.segments || []
      ).map(
        (seg: {
          start: number;
          end: number;
          text: string;
          avg_logprob?: number;
        }) => ({
          start: seg.start,
          end: seg.end,
          text: seg.text.trim(),
          confidence:
            typeof seg.avg_logprob === "number"
              ? Math.min(1, Math.max(0, Math.exp(seg.avg_logprob)))
              : undefined,
        }),
      );

      return {
        segments,
        language: transcription.language || language || "en",
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`OpenAI transcription failed: ${errorMessage}`);
    }
  }

  /**
   * Transcribe audio using local whisper.cpp
   */
  private async transcribeWithLocalWhisper(
    audioPath: string,
    language?: string,
  ): Promise<{ segments: TranscriptionSegment[]; language: string }> {
    const whisperPath = this.config.whisperBinaryPath;

    if (!(await checkToolAvailable(whisperPath))) {
      throw new Error(
        `Local whisper not found at '${whisperPath}'. Install with: pip install openai-whisper`,
      );
    }

    this.log(`Transcribing with local whisper: ${audioPath}`);

    const outputBase = audioPath.replace(/\.[^/.]+$/, "");
    const commandParts = [
      whisperPath,
      `"${audioPath}"`,
      "--output_format",
      "json",
      "--output_dir",
      `"${dirname(audioPath)}"`,
    ];

    if (language) {
      commandParts.push("--language", language);
    }

    if (this.config.whisperModelPath) {
      commandParts.push("--model", this.config.whisperModelPath);
    } else {
      commandParts.push("--model", "base");
    }

    const command = commandParts.join(" ");
    this.log(`Running: ${command}`);

    try {
      await execAsync(command, {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30 * 60 * 1000, // 30 minute timeout
      });

      // Read the JSON output
      const jsonPath = `${outputBase}.json`;
      const jsonContent = await readFile(jsonPath, "utf-8");
      const result = JSON.parse(jsonContent);

      // Clean up JSON file
      await unlink(jsonPath).catch(() => {});

      const segments: TranscriptionSegment[] = (result.segments || []).map(
        (seg: { start: number; end: number; text: string }) => ({
          start: seg.start,
          end: seg.end,
          text: seg.text.trim(),
        }),
      );

      return {
        segments,
        language: result.language || language || "en",
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Local whisper transcription failed: ${errorMessage}`);
    }
  }

  /**
   * Generate SRT format subtitles
   */
  private generateSRT(segments: TranscriptionSegment[]): string {
    return segments
      .map((segment, index) => {
        const startTime = this.formatSRTTime(segment.start);
        const endTime = this.formatSRTTime(segment.end);
        return `${index + 1}\n${startTime} --> ${endTime}\n${segment.text}\n`;
      })
      .join("\n");
  }

  /**
   * Generate VTT format subtitles
   */
  private generateVTT(segments: TranscriptionSegment[]): string {
    const header = "WEBVTT\n\n";
    const content = segments
      .map((segment) => {
        const startTime = this.formatVTTTime(segment.start);
        const endTime = this.formatVTTTime(segment.end);
        return `${startTime} --> ${endTime}\n${segment.text}\n`;
      })
      .join("\n");
    return header + content;
  }

  /**
   * Format time for SRT (HH:MM:SS,mmm)
   */
  private formatSRTTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")},${ms.toString().padStart(3, "0")}`;
  }

  /**
   * Format time for VTT (HH:MM:SS.mmm)
   */
  private formatVTTTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
  }

  /**
   * Check available subtitle generation engines
   */
  async getAvailableEngines(): Promise<WhisperEngineType[]> {
    const engines: WhisperEngineType[] = [];

    if (this.config.openaiApiKey) {
      engines.push("openai");
    }

    if (await checkToolAvailable(this.config.whisperBinaryPath)) {
      engines.push("local");
    }

    return engines;
  }
}
