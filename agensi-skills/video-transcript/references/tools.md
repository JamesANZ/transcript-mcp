# Transcript MCP tools

| Tool | Use it for |
| --- | --- |
| `list-transcript-languages` | Languages already available for a video URL |
| `get-transcript` | Existing captions. Required: `url`. Optional: `lang`, `include_timestamps`. |
| `download-video` | Save the video. Only when the user asks. |
| `list-downloads` | Files already in the storage directory |
| `generate-subtitles` | Create subtitles with speech-to-text. Only when the user asks. |
| `transcribe-audio` | Transcribe audio the user provided. Only when the user asks. |
| `transcribe_upload_start` | Start a chunked audio upload |
| `transcribe_upload_append` | Append one base64 chunk |
| `transcribe_upload_finalize` | Finish the upload and transcribe |
| `transcribe_get_job` | Poll an async transcription job |
| `transcribe_cancel_job` | Cancel a job when the user asks |
