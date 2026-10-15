# Video transcript

Fetches captions that already exist on YouTube, Vimeo, Bilibili, and other platforms `yt-dlp` supports. Download and speech-to-text are separate requests.

The server runs from a local checkout. It needs Node.js, `yt-dlp`, and `ffmpeg`.

## Connect

```json
{
  "mcpServers": {
    "transcript-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/transcript-mcp/dist/index.js"],
      "env": {
        "TRANSCRIPT_MCP_STORAGE_DIR": "/absolute/path/to/downloads",
        "OPENAI_API_KEY": ""
      }
    }
  }
}
```

`OPENAI_API_KEY` is only used when the buyer asks the server to generate subtitles or transcribe audio.

Build first, from this repository:

```bash
npm install
npm run build
```

## Package this listing

```bash
cd agensi-skills
zip -r video-transcript.zip video-transcript -x "*.DS_Store"
```

Upload `video-transcript.zip` in the Agensi creator dashboard. This repository does not submit the listing.
