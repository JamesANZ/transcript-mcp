/**
 * Subtitle generator using OpenAI Whisper API or local whisper.cpp
 */

import { exec } from "child_process";
import { promisify } from "util";
import { join, dirname, basename } from "path";
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

const execAsync = promisify(exec);

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
}

export interface AudioTranscriptionOptions {
  audioPath?: string;
  audioBase64?: string;
  audioResourceUri?: string;
  filename?: string;
  language?: string;
  engine?: WhisperEngineType | "auto";
}

export interface AudioTranscriptionResult {
  transcript: string;
  language: string;
  duration: number;
  engine: WhisperEngineType;
  segments: TranscriptionSegment[];
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
    const tempDir = await mkdtemp(join(tmpdir(), "video-toolkit-audio-"));
    let materializedAudioPath: string | undefined;
    let normalizedAudioPath: string | undefined;

    try {
      materializedAudioPath = await this.materializeAudioInput(options, tempDir);
      normalizedAudioPath = join(tempDir, "normalized.wav");
      await this.normalizeAudio(materializedAudioPath, normalizedAudioPath);

      const { selectedEngine, fallbackEngine } =
        await this.resolveTranscriptionEngines(options.engine);
      const language = options.language;
      let selectedResult:
        | { segments: TranscriptionSegment[]; language: string }
        | undefined;
      let usedEngine: WhisperEngineType = selectedEngine;
      let primaryError: string | undefined;

      try {
        selectedResult =
          selectedEngine === "openai"
            ? await this.transcribeWithOpenAI(normalizedAudioPath, language)
            : await this.transcribeWithLocalWhisper(normalizedAudioPath, language);
      } catch (error) {
        primaryError = error instanceof Error ? error.message : String(error);
      }

      if (!selectedResult && fallbackEngine) {
        this.log(
          `Primary ${selectedEngine} transcription failed, trying ${fallbackEngine} fallback`,
        );
        selectedResult =
          fallbackEngine === "openai"
            ? await this.transcribeWithOpenAI(normalizedAudioPath, language)
            : await this.transcribeWithLocalWhisper(normalizedAudioPath, language);
        usedEngine = fallbackEngine;
      }

      if (!selectedResult) {
        throw new Error(
          primaryError || "Transcription failed and no fallback engine available.",
        );
      }

      const transcript = selectedResult.segments.map((seg) => seg.text).join(" ");
      const duration = await this.getAudioDuration(normalizedAudioPath);

      return {
        transcript,
        language: selectedResult.language,
        duration,
        engine: usedEngine,
        segments: selectedResult.segments,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
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
    ].filter(Boolean);

    if (providedInputs.length !== 1) {
      throw new Error(
        "Provide exactly one audio input: audio_path, audio_base64, or audio_resource_uri.",
      );
    }

    if (options.audioPath) {
      await stat(options.audioPath).catch(() => {
        throw new Error(`Audio file not found: ${options.audioPath}`);
      });
      const pathFromName = options.filename || basename(options.audioPath);
      const outputPath = join(tempDir, pathFromName);
      await copyFile(options.audioPath, outputPath);
      return outputPath;
    }

    if (options.audioBase64) {
      const filename = options.filename || "audio-upload.bin";
      const outputPath = join(tempDir, filename);
      const bytes = Buffer.from(options.audioBase64, "base64");
      if (bytes.length === 0) {
        throw new Error("audio_base64 decoded to an empty payload.");
      }
      await writeFile(outputPath, bytes);
      return outputPath;
    }

    const uri = options.audioResourceUri as string;
    if (uri.startsWith("file://")) {
      const filePath = decodeURIComponent(uri.replace("file://", ""));
      await stat(filePath).catch(() => {
        throw new Error(`Audio resource URI file not found: ${uri}`);
      });
      const pathFromName = options.filename || basename(filePath);
      const outputPath = join(tempDir, pathFromName);
      await copyFile(filePath, outputPath);
      return outputPath;
    }

    if (uri.startsWith("data:")) {
      const match = uri.match(/^data:.*?;base64,(.+)$/);
      if (!match) {
        throw new Error(
          "Unsupported data URI format. Expected base64-encoded data URI.",
        );
      }
      const filename = options.filename || "audio-resource.bin";
      const outputPath = join(tempDir, filename);
      const bytes = Buffer.from(match[1], "base64");
      if (bytes.length === 0) {
        throw new Error("audio_resource_uri data URI decoded to empty payload.");
      }
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
      ).map((seg: { start: number; end: number; text: string }) => ({
        start: seg.start,
        end: seg.end,
        text: seg.text.trim(),
      }));

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
