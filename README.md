# Video Toolkit MCP Server

[glama](https://glama.ai/mcp/servers/JamesANZ/video-toolkit-mcp)

A Model Context Protocol (MCP) server that provides comprehensive video tools: transcript retrieval, video downloading, automatic subtitle generation, and direct audio transcription. Works with YouTube, Bilibili, Vimeo, and any platform supported by yt-dlp.

## Features

- **Multi-Platform Support**: Works with YouTube, Bilibili, Vimeo, and any platform supported by yt-dlp
- **Video Transcripts**: Extract existing transcripts/captions from videos
- **Video Downloads**: Download videos to local storage in various formats and qualities
- **Auto Subtitle Generation**: Generate subtitles using OpenAI Whisper API or local Whisper
- **Client Audio Transcription**: Transcribe audio supplied via file paths, base64 payloads, or resource URIs
- **Multiple URL Formats**: Support for various URL formats from different platforms
- **Timestamp Support**: Include or exclude timestamps in transcript output
- **Language Selection**: Request transcripts or generate subtitles in specific languages

## Tools

| Tool                        | Description                                        |
| --------------------------- | -------------------------------------------------- |
| `get-transcript`            | Retrieve existing transcripts from video platforms |
| `list-transcript-languages` | List available transcript languages for a video    |
| `download-video`            | Download videos to local storage                   |
| `list-downloads`            | List downloaded video files                        |
| `generate-subtitles`        | Generate subtitles using AI speech-to-text         |
| `transcribe-audio`          | Transcribe client-provided audio                   |

## Prerequisites

- **Node.js** >= 16.0.0
- **yt-dlp** - Required for transcript fetching and video downloads
- **ffmpeg** - Required for subtitle generation (audio extraction)

### Installing Dependencies

**yt-dlp (required):**

```bash
# Using Homebrew (macOS)
brew install yt-dlp

# Using pip
pip install yt-dlp
```

**ffmpeg (required for subtitle generation):**

```bash
# Using Homebrew (macOS)
brew install ffmpeg

# Using apt (Ubuntu/Debian)
sudo apt install ffmpeg
```

**Local Whisper (optional, for local subtitle generation):**

```bash
pip install openai-whisper
```

## Installation

### From Source

```bash
git clone <repository-url>
cd video-toolkit-mcp
npm install
npm run build
```

### Global Installation (after publishing)

```bash
npm install -g video-toolkit-mcp
```

## Configuration

### For Claude Desktop / Cursor

Add the MCP server to your configuration file:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "video-toolkit-mcp": {
      "command": "node",
      "args": ["/path/to/video-toolkit-mcp/dist/index.js"],
      "env": {
        "VIDEO_TOOLKIT_STORAGE_DIR": "/path/to/downloads",
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "video-toolkit-mcp": {
      "command": "node",
      "args": ["/path/to/video-toolkit-mcp/dist/index.js"],
      "env": {
        "VIDEO_TOOLKIT_STORAGE_DIR": "/path/to/downloads",
        "OPENAI_API_KEY": "your-openai-api-key"
      }
    }
  }
}
```

### Environment Variables

| Variable                       | Description                                            | Default                      |
| ------------------------------ | ------------------------------------------------------ | ---------------------------- |
| `VIDEO_TOOLKIT_STORAGE_DIR`    | Default directory for downloaded videos                | `~/.video-toolkit/downloads` |
| `OPENAI_API_KEY`               | OpenAI API key for Whisper-based subtitle generation   | None                         |
| `VIDEO_TOOLKIT_WHISPER_ENGINE` | Preferred whisper engine: `openai`, `local`, or `auto` | `auto`                       |
| `WHISPER_BINARY_PATH`          | Path to local whisper binary                           | `whisper`                    |
| `WHISPER_MODEL_PATH`           | Path to whisper model (for local whisper)              | Auto-download                |
| `YT_DLP_PATH`                  | Path to yt-dlp binary                                  | `yt-dlp`                     |
| `FFMPEG_PATH`                  | Path to ffmpeg binary                                  | `ffmpeg`                     |
| `FFPROBE_PATH`                 | Path to ffprobe binary                                 | Derived from `FFMPEG_PATH`   |
| `DEBUG`                        | Enable debug logging                                   | `0`                          |

## Usage

### 1. get-transcript

Retrieve existing transcripts from video platforms.

**Parameters:**

- `url` (required): Video URL
- `lang` (optional): Language code (e.g., 'en', 'es', 'zh')
- `include_timestamps` (optional): Include timestamps (default: true)

**Example:**

```
Get the transcript from https://www.youtube.com/watch?v=VIDEO_ID
```

### 2. list-transcript-languages

List available transcript languages for a video.

**Parameters:**

- `url` (required): Video URL

**Example:**

```
What transcript languages are available for https://www.youtube.com/watch?v=VIDEO_ID?
```

### 3. download-video

Download a video to local storage.

**Parameters:**

- `url` (required): Video URL to download
- `output_dir` (optional): Custom output directory
- `filename` (optional): Custom filename
- `format` (optional): Video format - `mp4`, `webm`, `mkv` (default: mp4)
- `quality` (optional): Quality - `best`, `1080p`, `720p`, `480p`, `360p`, `audio` (default: best)

**Example:**

```
Download this video: https://www.youtube.com/watch?v=VIDEO_ID
```

### 4. list-downloads

List all downloaded video files.

**Parameters:**

- `directory` (optional): Directory to list (default: storage directory)

**Example:**

```
List my downloaded videos
```

### 5. generate-subtitles

Generate subtitles for a local video file using AI speech-to-text.

**Parameters:**

- `video_path` (required): Absolute path to the video file
- `engine` (optional): `openai` or `local` (default: auto-detect)
- `language` (optional): Language code for transcription
- `output_format` (optional): `srt` or `vtt` (default: srt)

**Example:**

```
Generate subtitles for /path/to/video.mp4
```

### 6. transcribe-audio

Transcribe audio sent by the MCP client. Supports multiple input contracts and normalizes audio to a stable format before transcription.

**Parameters:**

- One required input source (exactly one):
  - `audio_path`: Absolute path to a local audio file
  - `audio_base64`: Base64-encoded audio payload
  - `audio_resource_uri`: URI using `file://` or `data:...;base64,...`
- `filename` (optional): Filename used for base64/resource inputs
- `engine` (optional): `openai`, `local`, or `auto` (default: `auto`)
- `language` (optional): Language hint for transcription
- `include_timestamps` (optional): Include timestamps in output (default: true)

**Examples:**

```
Transcribe this audio file: /path/to/interview.m4a
```

```
Transcribe this base64 audio payload using local engine
```

## Subtitle Generation Engines

### OpenAI Whisper API

- **Pros**: High accuracy, no local setup needed, supports 50+ languages
- **Cons**: Requires API key, costs per audio minute
- **Setup**: Set `OPENAI_API_KEY` environment variable

### Local Whisper

- **Pros**: Free, runs locally, no API limits
- **Cons**: Requires setup, uses local CPU/GPU
- **Setup**: `pip install openai-whisper`

The tool auto-detects which engine to use:

1. If `OPENAI_API_KEY` is set, uses OpenAI Whisper
2. If local whisper is installed, uses local whisper
3. Returns an error if neither is available

For `transcribe-audio`, `auto` uses OpenAI first and falls back to local whisper when local whisper is available.

## Example Workflows

### Download and Generate Subtitles

```
1. Download this video: https://www.youtube.com/watch?v=VIDEO_ID
2. Generate subtitles for the downloaded file
```

### Summarize a Video

```
Get the transcript from https://www.youtube.com/watch?v=VIDEO_ID and summarize the key points
```

### Create Captions for Videos Without Subtitles

```
1. Download the video: https://vimeo.com/123456789
2. Generate English subtitles for it
```

## Supported Platforms

Any platform supported by yt-dlp, including:

- YouTube
- Bilibili
- Vimeo
- Twitter/X
- TikTok
- Twitch
- And many more...

Full list: https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md

## Project Structure

```
video-toolkit-mcp/
├── src/
│   ├── index.ts              # Main MCP server entry point
│   ├── transcript-fetcher.ts # Transcript fetching using yt-dlp
│   ├── video-downloader.ts   # Video download functionality
│   ├── subtitle-generator.ts # AI-powered subtitle generation
│   ├── config.ts             # Configuration management
│   ├── url-detector.ts       # Platform detection from URLs
│   ├── parser.ts             # Transcript parsing (SRT, VTT, JSON)
│   └── errors.ts             # Custom error classes
├── test/
│   └── transcript.test.ts    # Unit tests
├── dist/                     # Compiled JavaScript (after build)
└── package.json
```

## Development

```bash
# Build
npm run build

# Test
npm test

# Development mode
npm run dev
```

## Troubleshooting

### "yt-dlp is not installed"

```bash
brew install yt-dlp
# or
pip install yt-dlp
```

### "ffmpeg is not installed"

```bash
brew install ffmpeg
```

### "ffprobe is not installed"

```bash
brew install ffmpeg
```

### "No Whisper engine available"

Either:

- Set `OPENAI_API_KEY` environment variable, or
- Install local whisper: `pip install openai-whisper`

### Download issues

- Check if the video is publicly accessible
- Some platforms may have rate limits
- Private/restricted videos cannot be downloaded

### Subtitle generation is slow

- OpenAI Whisper API is faster than local
- Local whisper performance depends on your hardware
- Consider using a smaller model for local whisper

## License

MIT

## Acknowledgments

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) for video platform support
- [OpenAI Whisper](https://openai.com/research/whisper) for speech-to-text
- [Model Context Protocol](https://modelcontextprotocol.io/) for the MCP framework
