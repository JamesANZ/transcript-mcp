#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile, mkdtemp, writeFile, rm } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { TranscriptFetcher } from "./transcript-fetcher.js";
import { validateUrl } from "./url-detector.js";
import { getConfig, Config } from "./config.js";
import { VideoDownloader } from "./video-downloader.js";
import {
  SubtitleGenerator,
  WhisperEngineType,
  StructuredTranscriptionResult,
  TranscribeAsyncQueued,
} from "./subtitle-generator.js";
import { TranscribeJobManager } from "./transcribe-job-manager.js";
import { UploadSessionManager } from "./upload-session-manager.js";

// Get package.json path for version info
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// When running from dist/, package.json is in ../package.json
const packageJson = JSON.parse(
  await readFile(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

/**
 * MCP Server for Generic Video Transcript Retrieval
 * Provides tools for fetching transcripts from multiple video platforms
 */
class TranscriptMCPServer {
  private server: Server;
  private fetcher: TranscriptFetcher;
  private downloader: VideoDownloader;
  private subtitleGenerator: SubtitleGenerator;
  private transcribeJobManager: TranscribeJobManager;
  private uploadSessionManager: UploadSessionManager;
  private config: Config;

  constructor() {
    this.server = new Server(
      {
        name: "video-toolkit-mcp-server",
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    // Initialize configuration
    this.config = getConfig();

    // Initialize transcript fetcher
    this.fetcher = new TranscriptFetcher({
      debug: this.config.debug,
    });

    // Initialize video downloader
    this.downloader = new VideoDownloader(this.config);

    // Initialize subtitle generator
    this.subtitleGenerator = new SubtitleGenerator(this.config);
    this.transcribeJobManager = new TranscribeJobManager(this.subtitleGenerator);
    this.uploadSessionManager = new UploadSessionManager();

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "get-transcript",
          description:
            "Retrieve the transcript of a video from supported platforms (YouTube, Bilibili, Vimeo, etc.). Accepts various URL formats and returns the full transcript with timestamps.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              url: {
                type: "string",
                description:
                  "Video URL from any supported platform (e.g., YouTube, Bilibili, Vimeo). Examples: https://www.youtube.com/watch?v=VIDEO_ID, https://www.bilibili.com/video/BVxxxxx, https://vimeo.com/123456789",
              },
              lang: {
                type: "string",
                description:
                  "Language code for transcript (e.g., 'en', 'es', 'fr', 'zh'). Default: video's default language",
              },
              include_timestamps: {
                type: "boolean",
                description:
                  "Include timestamps in the transcript output. Default: true",
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
        {
          name: "list-transcript-languages",
          description:
            "List all available transcript languages for a video from any supported platform.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              url: {
                type: "string",
                description:
                  "Video URL from any supported platform (YouTube, Bilibili, Vimeo, etc.)",
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
        {
          name: "download-video",
          description:
            "Download a video from any supported platform (YouTube, Vimeo, etc.) to local storage. Returns the file path of the downloaded video.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              url: {
                type: "string",
                description:
                  "Video URL from any supported platform (e.g., YouTube, Vimeo)",
              },
              output_dir: {
                type: "string",
                description:
                  "Custom output directory. Default: configured storage directory",
              },
              filename: {
                type: "string",
                description:
                  "Custom filename for the downloaded video. Default: video title",
              },
              format: {
                type: "string",
                enum: ["mp4", "webm", "mkv"],
                description: "Output video format. Default: mp4",
              },
              quality: {
                type: "string",
                enum: ["best", "1080p", "720p", "480p", "360p", "audio"],
                description: "Video quality. Default: best",
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
        {
          name: "list-downloads",
          description:
            "List all downloaded video files in the storage directory or a specified directory.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              directory: {
                type: "string",
                description:
                  "Directory to list. Default: configured storage directory",
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: "generate-subtitles",
          description:
            "Generate subtitles for a local video file using AI speech-to-text (OpenAI Whisper or local whisper). Creates an SRT or VTT file alongside the video.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              video_path: {
                type: "string",
                description:
                  "Absolute path to the local video file to generate subtitles for",
              },
              engine: {
                type: "string",
                enum: ["openai", "local"],
                description:
                  "Whisper engine to use. 'openai' uses OpenAI Whisper API (requires OPENAI_API_KEY), 'local' uses locally installed whisper. Default: auto-detect",
              },
              language: {
                type: "string",
                description:
                  "Language code for transcription (e.g., 'en', 'es', 'fr'). Default: auto-detect",
              },
              output_format: {
                type: "string",
                enum: ["srt", "vtt"],
                description: "Subtitle format. Default: srt",
              },
            },
            required: ["video_path"],
            additionalProperties: false,
          },
        },
        {
          name: "transcribe-audio",
          description:
            "Transcribes audio via Whisper. Preferred: audio_url (most token-efficient; server fetches bytes). audio_base64 is for small clips only (<= ~60KB raw per call). audio_path only works when the MCP host shares a filesystem with the caller (often false on Claude.ai / Claude Code). For larger payloads in sandboxed environments, use transcribe_upload_start / transcribe_upload_append / transcribe_upload_finalize. Server re-encodes to Opus 16kHz mono 16kbps before Whisper unless skip_compression=true. Long audio (>5min) or async=true returns a job_id; poll transcribe_get_job.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              audio_path: {
                type: "string",
                description:
                  "Absolute path to a local audio file on the MCP host (often unusable from sandboxed clients).",
              },
              audio_base64: {
                type: "string",
                description:
                  "Base64-encoded audio payload (single-call max ~60KB raw; use chunked upload for larger).",
              },
              audio_resource_uri: {
                type: "string",
                description:
                  "Audio resource URI, supported schemes: file:// and data:...;base64,...",
              },
              audio_url: {
                type: "string",
                description:
                  "HTTP(S) URL the server will fetch (requires TRANSCRIPT_MCP_URL_ALLOWLIST).",
              },
              filename: {
                type: "string",
                description:
                  "Optional filename hint (used when magic-byte detection is inconclusive).",
              },
              skip_compression: {
                type: "boolean",
                description:
                  "If true, skip Opus 16kbps recompression (caller already optimized). Default: false",
              },
              engine: {
                type: "string",
                enum: ["openai", "local", "auto"],
                description:
                  "Transcription engine preference. 'auto' uses OpenAI first and falls back to local whisper when available.",
              },
              language: {
                type: "string",
                description:
                  "Language code for transcription (e.g., 'en', 'es', 'fr'). Default: auto-detect",
              },
              include_timestamps: {
                type: "boolean",
                description:
                  "When as_text=true, include [MM:SS] timestamps in the plain text output. Default: true",
              },
              as_text: {
                type: "boolean",
                description:
                  "If true, return only the joined transcript string. If false, return structured JSON. Default: false",
              },
              async: {
                type: "boolean",
                description:
                  "If true, always enqueue an async job (returns job_id). Default: false",
              },
            },
            oneOf: [
              { required: ["audio_path"] },
              { required: ["audio_base64"] },
              { required: ["audio_resource_uri"] },
              { required: ["audio_url"] },
            ],
            additionalProperties: false,
          },
        },
        {
          name: "transcribe_upload_start",
          description:
            "Begin a chunked audio upload for large payloads. Returns upload_id and max_chunk_bytes (~60KB).",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              filename: { type: "string", description: "Original filename hint" },
              expected_chunks: {
                type: "integer",
                minimum: 1,
                description: "Total number of base64 chunks you will upload",
              },
              language: { type: "string" },
              include_timestamps: { type: "boolean" },
            },
            required: ["filename", "expected_chunks"],
            additionalProperties: false,
          },
        },
        {
          name: "transcribe_upload_append",
          description: "Append one base64 chunk to an upload session.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              upload_id: { type: "string" },
              chunk_index: { type: "integer", minimum: 0 },
              audio_base64: { type: "string" },
            },
            required: ["upload_id", "chunk_index", "audio_base64"],
            additionalProperties: false,
          },
        },
        {
          name: "transcribe_upload_finalize",
          description:
            "Finalize a chunked upload, run compression + Whisper, return structured JSON (or text with as_text).",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              upload_id: { type: "string" },
              skip_compression: { type: "boolean" },
              engine: { type: "string", enum: ["openai", "local", "auto"] },
              language: { type: "string" },
              as_text: { type: "boolean" },
              async: { type: "boolean" },
            },
            required: ["upload_id"],
            additionalProperties: false,
          },
        },
        {
          name: "transcribe_get_job",
          description: "Poll an async transcription job created by transcribe-audio.",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              job_id: { type: "string" },
              as_text: { type: "boolean" },
            },
            required: ["job_id"],
            additionalProperties: false,
          },
        },
        {
          name: "transcribe_cancel_job",
          description: "Cancel an async transcription job (best-effort).",
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { job_id: { type: "string" } },
            required: ["job_id"],
            additionalProperties: false,
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        if (!args) {
          throw new Error("Missing arguments");
        }

        switch (name) {
          case "get-transcript":
            return await this.handleGetTranscript(
              args as {
                url: string;
                lang?: string;
                include_timestamps?: boolean;
              },
            );
          case "list-transcript-languages":
            return await this.handleListLanguages(args as { url: string });
          case "download-video":
            return await this.handleDownloadVideo(
              args as {
                url: string;
                output_dir?: string;
                filename?: string;
                format?: string;
                quality?: string;
              },
            );
          case "list-downloads":
            return await this.handleListDownloads(
              args as { directory?: string },
            );
          case "generate-subtitles":
            return await this.handleGenerateSubtitles(
              args as {
                video_path: string;
                engine?: string;
                language?: string;
                output_format?: string;
              },
            );
          case "transcribe-audio":
            return await this.handleTranscribeAudio(
              args as {
                audio_path?: string;
                audio_base64?: string;
                audio_resource_uri?: string;
                audio_url?: string;
                filename?: string;
                engine?: string;
                language?: string;
                include_timestamps?: boolean;
                skip_compression?: boolean;
                as_text?: boolean;
                async?: boolean;
              },
            );
          case "transcribe_upload_start":
            return await this.handleTranscribeUploadStart(
              args as {
                filename: string;
                expected_chunks: number;
                language?: string;
                include_timestamps?: boolean;
              },
            );
          case "transcribe_upload_append":
            return await this.handleTranscribeUploadAppend(
              args as {
                upload_id: string;
                chunk_index: number;
                audio_base64: string;
              },
            );
          case "transcribe_upload_finalize":
            return await this.handleTranscribeUploadFinalize(
              args as {
                upload_id: string;
                skip_compression?: boolean;
                engine?: string;
                language?: string;
                as_text?: boolean;
                async?: boolean;
              },
            );
          case "transcribe_get_job":
            return await this.handleTranscribeGetJob(
              args as { job_id: string; as_text?: boolean },
            );
          case "transcribe_cancel_job":
            return await this.handleTranscribeCancelJob(args as { job_id: string });
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Format transcript with or without timestamps
   */
  private formatTranscript(
    snippets: Array<{ text: string; start: number; duration: number }>,
    includeTimestamps: boolean = true,
  ): string {
    if (includeTimestamps) {
      return snippets
        .map((entry) => {
          const timestamp = this.formatTime(entry.start);
          return `[${timestamp}] ${entry.text}`;
        })
        .join("\n");
    } else {
      return snippets.map((entry) => entry.text).join(" ");
    }
  }

  /**
   * Format seconds to MM:SS or HH:MM:SS
   */
  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${minutes}:${secs.toString().padStart(2, "0")}`;
  }

  private async handleGetTranscript(args: {
    url: string;
    lang?: string;
    include_timestamps?: boolean;
  }): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const { url, lang, include_timestamps = true } = args;

    // Validate URL
    validateUrl(url);

    // Fetch transcript
    const result = await this.fetcher.fetchTranscript(url, {
      language: lang,
    });

    if (!result.snippets || result.snippets.length === 0) {
      throw new Error("No transcript available for this video.");
    }

    const formattedTranscript = this.formatTranscript(
      result.snippets,
      include_timestamps,
    );

    const resultText = [
      `Video Transcript`,
      `URL: ${result.url}`,
      result.languageCode
        ? `Language: ${result.languageCode}${result.isGenerated ? " (auto-generated)" : ""}`
        : "",
      `\n${formattedTranscript}`,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: resultText,
        },
      ],
    };
  }

  private async handleListLanguages(args: { url: string }): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const { url } = args;

    // Validate URL
    validateUrl(url);

    try {
      const languages = await this.fetcher.listLanguages(url);

      if (languages.length === 0) {
        throw new Error("No transcripts are available for this video.");
      }

      // Format the output
      const languageList = languages
        .map((lang) => {
          const autoGenLabel = lang.isAutoGenerated ? " (auto-generated)" : "";
          return `  - ${lang.code}: ${lang.name}${autoGenLabel}`;
        })
        .join("\n");

      const result = [
        `Video URL: ${url}`,
        `\nAvailable transcript languages (${languages.length}):`,
        languageList,
        `\nTo get a transcript in a specific language, use the get-transcript tool with the 'lang' parameter.`,
        languages.length > 0
          ? `Example: lang='${languages[0].code}' for ${languages[0].name}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      throw new Error(
        `Could not fetch transcript information: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleDownloadVideo(args: {
    url: string;
    output_dir?: string;
    filename?: string;
    format?: string;
    quality?: string;
  }): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const { url, output_dir, filename, format, quality } = args;

    // Validate URL
    validateUrl(url);

    try {
      const result = await this.downloader.downloadVideo({
        url,
        outputDir: output_dir,
        filename,
        format,
        quality,
      });

      const formattedSize = VideoDownloader.formatFileSize(result.fileSize);
      const formattedDuration = VideoDownloader.formatDuration(result.duration);

      const output = [
        `Video Downloaded Successfully`,
        ``,
        `Title: ${result.title}`,
        `Duration: ${formattedDuration}`,
        `Size: ${formattedSize}`,
        `Format: ${result.format}`,
        ``,
        `File saved to: ${result.filePath}`,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    } catch (error) {
      throw new Error(
        `Failed to download video: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleListDownloads(args: { directory?: string }): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const { directory } = args;

    try {
      const downloads = await this.downloader.listDownloads(directory);
      const targetDir = directory || this.config.storageDir;

      if (downloads.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No video files found in: ${targetDir}`,
            },
          ],
        };
      }

      const fileList = downloads
        .map((file, index) => {
          const size = VideoDownloader.formatFileSize(file.size);
          const date = file.createdAt.toLocaleDateString();
          return `${index + 1}. ${file.filename}\n   Size: ${size} | Downloaded: ${date}\n   Path: ${file.path}`;
        })
        .join("\n\n");

      const output = [
        `Downloaded Videos (${downloads.length} files)`,
        `Directory: ${targetDir}`,
        ``,
        fileList,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    } catch (error) {
      throw new Error(
        `Failed to list downloads: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleGenerateSubtitles(args: {
    video_path: string;
    engine?: string;
    language?: string;
    output_format?: string;
  }): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const { video_path, engine, language, output_format } = args;

    try {
      // Check available engines first
      const availableEngines =
        await this.subtitleGenerator.getAvailableEngines();

      if (availableEngines.length === 0) {
        throw new Error(
          "No subtitle generation engine available. Either:\n" +
            "- Set OPENAI_API_KEY environment variable for OpenAI Whisper, or\n" +
            "- Install whisper locally: pip install openai-whisper",
        );
      }

      const result = await this.subtitleGenerator.generateSubtitles({
        videoPath: video_path,
        engine: engine as WhisperEngineType | undefined,
        language,
        outputFormat: output_format as "srt" | "vtt" | undefined,
      });

      const formattedDuration = VideoDownloader.formatDuration(result.duration);

      const output = [
        `Subtitles Generated Successfully`,
        ``,
        `Engine: ${result.engine === "openai" ? "OpenAI Whisper API" : "Local Whisper"}`,
        `Language: ${result.language}`,
        `Duration: ${formattedDuration}`,
        ``,
        `Subtitle file saved to: ${result.subtitlePath}`,
      ].join("\n");

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    } catch (error) {
      throw new Error(
        `Failed to generate subtitles: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private formatTranscriptionPayload(
    payload: StructuredTranscriptionResult | TranscribeAsyncQueued,
    asText: boolean | undefined,
    includeTimestamps: boolean | undefined,
  ): string {
    if ("job_id" in payload) {
      return JSON.stringify(payload, null, 2);
    }
    if (asText) {
      if (includeTimestamps) {
        return this.formatTranscript(
          payload.segments.map((segment) => ({
            text: segment.text,
            start: segment.start,
            duration: Math.max(0, segment.end - segment.start),
          })),
          true,
        );
      }
      return payload.text;
    }
    return JSON.stringify(payload, null, 2);
  }

  private async handleTranscribeAudio(args: {
    audio_path?: string;
    audio_base64?: string;
    audio_resource_uri?: string;
    audio_url?: string;
    filename?: string;
    engine?: string;
    language?: string;
    include_timestamps?: boolean;
    skip_compression?: boolean;
    as_text?: boolean;
    async?: boolean;
  }): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }> {
    const {
      audio_path,
      audio_base64,
      audio_resource_uri,
      audio_url,
      filename,
      engine,
      language,
      include_timestamps = true,
      skip_compression = false,
      as_text = false,
      async: asyncFlag = false,
    } = args;

    try {
      const providedInputs = [
        audio_path,
        audio_base64,
        audio_resource_uri,
        audio_url,
      ].filter(Boolean);
      if (providedInputs.length !== 1) {
        throw new Error(
          "Provide exactly one of: audio_path, audio_base64, audio_resource_uri, or audio_url.",
        );
      }

      const result = await this.subtitleGenerator.transcribeAudioStructured(
        {
          audioPath: audio_path,
          audioBase64: audio_base64,
          audioResourceUri: audio_resource_uri,
          audioUrl: audio_url,
          filename,
          engine: (engine as WhisperEngineType | "auto" | undefined) || "auto",
          language,
          skipCompression: skip_compression,
          async: asyncFlag,
        },
        this.transcribeJobManager,
      );

      return {
        content: [
          {
            type: "text",
            text: this.formatTranscriptionPayload(
              result,
              as_text,
              include_timestamps,
            ),
          },
        ],
      };
    } catch (error) {
      throw new Error(
        `Failed to transcribe audio: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleTranscribeUploadStart(args: {
    filename: string;
    expected_chunks: number;
    language?: string;
    include_timestamps?: boolean;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { uploadId, maxChunkBytes } = await this.uploadSessionManager.createSession({
      filename: args.filename,
      expectedChunks: args.expected_chunks,
      language: args.language,
      includeTimestamps: args.include_timestamps,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { upload_id: uploadId, max_chunk_bytes: maxChunkBytes },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async handleTranscribeUploadAppend(args: {
    upload_id: string;
    chunk_index: number;
    audio_base64: string;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const progress = await this.uploadSessionManager.appendChunk(
      args.upload_id,
      args.chunk_index,
      args.audio_base64,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(progress, null, 2),
        },
      ],
    };
  }

  private async handleTranscribeUploadFinalize(args: {
    upload_id: string;
    skip_compression?: boolean;
    engine?: string;
    language?: string;
    as_text?: boolean;
    async?: boolean;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const session = this.uploadSessionManager.getSession(args.upload_id);
    if (!session) {
      throw new Error(`Unknown upload_id: ${args.upload_id}`);
    }

    let tempDir: string | undefined;
    try {
      const buffer = await this.uploadSessionManager.readConcatenated(args.upload_id);
      tempDir = await mkdtemp(join(tmpdir(), "transcribe-upload-final-"));
      const filePath = join(tempDir, session.filename);
      await writeFile(filePath, buffer);

      const result = await this.subtitleGenerator.transcribeAudioFromFilePath(
        filePath,
        {
          language: args.language ?? session.language,
          engine: (args.engine as WhisperEngineType | "auto" | undefined) || "auto",
          skipCompression: Boolean(args.skip_compression),
          filenameHint: session.filename,
          async: Boolean(args.async),
        },
        this.transcribeJobManager,
      );

      return {
        content: [
          {
            type: "text",
            text: this.formatTranscriptionPayload(
              result,
              args.as_text,
              session.includeTimestamps,
            ),
          },
        ],
      };
    } finally {
      await this.uploadSessionManager.finalizeAndRemove(args.upload_id);
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async handleTranscribeGetJob(args: {
    job_id: string;
    as_text?: boolean;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const job = this.transcribeJobManager.getJob(args.job_id);
    if (job.status === "completed" && job.result) {
      return {
        content: [
          {
            type: "text",
            text: this.formatTranscriptionPayload(job.result, args.as_text, false),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(job, null, 2),
        },
      ],
    };
  }

  private async handleTranscribeCancelJob(args: {
    job_id: string;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const ok = this.transcribeJobManager.cancelJob(args.job_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok }, null, 2),
        },
      ],
    };
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`Video Toolkit MCP Server v${VERSION} running on stdio`);
  }
}

// Start the server
const server = new TranscriptMCPServer();
server.start().catch(console.error);
