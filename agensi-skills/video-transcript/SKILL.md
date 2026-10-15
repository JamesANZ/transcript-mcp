---
name: video-transcript
description: Fetches an existing video transcript through the connected transcript MCP server. Use when the user asks for a YouTube, Vimeo, or Bilibili transcript, captions, or the words spoken in a video. Download, subtitle generation, and audio transcription only when they ask for those specifically.
---

# Video transcripts

The transcript MCP server must already be connected, with `yt-dlp` and `ffmpeg` on the machine that runs it. If `get-transcript` is missing, stop and give the user the install block in README.md. Do not invent a transcript.

## Workflow

1. Call `list-transcript-languages` with the video URL.
2. Call `get-transcript` for the language they asked for, or the default language when they did not name one. Set `include_timestamps` from their request. Default is timestamps on.
3. Call `download-video` only when they ask to save the file. Call `list-downloads` when they ask what is already saved.
4. Call `generate-subtitles` or `transcribe-audio` only when they ask to create captions or transcribe audio that has no captions. Those paths need the buyer's `OPENAI_API_KEY` unless they are using a local Whisper setup the server already has. For a large upload, use `transcribe_upload_start`, `transcribe_upload_append`, then `transcribe_upload_finalize`. Poll with `transcribe_get_job`. Cancel with `transcribe_cancel_job` only when they ask.

## Output

- The URL and language
- The transcript text, or a short quote plus where the full text is if it is very long
- The tool that produced it

## Boundaries

Do not download a video as a side effect of a transcript request. If the tool says captions are unavailable, say that and wait for them to ask for transcription.
