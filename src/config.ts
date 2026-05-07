/**
 * Centralized configuration management for transcript-mcp
 */

import { homedir } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export type WhisperEngine = "openai" | "local" | "auto";

export interface Config {
  storageDir: string;
  whisperEngine: WhisperEngine;
  openaiApiKey?: string;
  whisperBinaryPath: string;
  whisperModelPath?: string;
  ytDlpPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  /** Comma-separated host patterns for server-side audio_url fetches (empty = disallow all). */
  transcriptMcpUrlAllowlist: string;
  debug: boolean;
}

const DEFAULT_STORAGE_DIR = join(homedir(), ".transcript-mcp", "downloads");

/**
 * Get configuration from environment variables with sensible defaults
 */
export function getConfig(): Config {
  return {
    storageDir:
      process.env.TRANSCRIPT_MCP_STORAGE_DIR ||
      process.env.VIDEO_TOOLKIT_STORAGE_DIR ||
      DEFAULT_STORAGE_DIR,
    whisperEngine:
      (process.env.TRANSCRIPT_MCP_WHISPER_ENGINE as WhisperEngine) ||
      (process.env.VIDEO_TOOLKIT_WHISPER_ENGINE as WhisperEngine) ||
      "auto",
    openaiApiKey: process.env.OPENAI_API_KEY,
    whisperBinaryPath: process.env.WHISPER_BINARY_PATH || "whisper",
    whisperModelPath: process.env.WHISPER_MODEL_PATH,
    ytDlpPath: process.env.YT_DLP_PATH || "yt-dlp",
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobePath:
      process.env.FFPROBE_PATH ||
      (process.env.FFMPEG_PATH || "ffmpeg").replace("ffmpeg", "ffprobe"),
    transcriptMcpUrlAllowlist: process.env.TRANSCRIPT_MCP_URL_ALLOWLIST || "",
    debug: process.env.DEBUG === "1",
  };
}

/**
 * Ensure the storage directory exists
 */
export async function ensureStorageDir(config: Config): Promise<void> {
  await mkdir(config.storageDir, { recursive: true });
}

/**
 * Check if a command-line tool is available
 */
export async function checkToolAvailable(toolPath: string): Promise<boolean> {
  try {
    const executable = toolPath.split(" ")[0];
    await execAsync(`which ${executable}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the best available whisper engine
 */
export async function detectWhisperEngine(
  config: Config,
): Promise<"openai" | "local" | null> {
  if (config.whisperEngine !== "auto") {
    if (config.whisperEngine === "openai" && config.openaiApiKey) {
      return "openai";
    }
    if (
      config.whisperEngine === "local" &&
      (await checkToolAvailable(config.whisperBinaryPath))
    ) {
      return "local";
    }
    return null;
  }

  // Auto-detect: prefer OpenAI if API key is available
  if (config.openaiApiKey) {
    return "openai";
  }

  // Fall back to local whisper
  if (await checkToolAvailable(config.whisperBinaryPath)) {
    return "local";
  }

  return null;
}

/**
 * Validate required tools are available
 */
export async function validateRequiredTools(
  config: Config,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  if (!(await checkToolAvailable(config.ytDlpPath))) {
    errors.push(
      `yt-dlp not found at '${config.ytDlpPath}'. Install with: brew install yt-dlp`,
    );
  }

  if (!(await checkToolAvailable(config.ffmpegPath))) {
    errors.push(
      `ffmpeg not found at '${config.ffmpegPath}'. Install with: brew install ffmpeg`,
    );
  }

  if (!(await checkToolAvailable(config.ffprobePath))) {
    errors.push(
      `ffprobe not found at '${config.ffprobePath}'. Install with: brew install ffmpeg`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
