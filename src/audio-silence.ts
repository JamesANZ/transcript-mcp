import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

const MAX_SEGMENT_SECONDS = 600;

/**
 * Use ffmpeg silencedetect on a mono WAV to find non-silent intervals, then merge/cap length.
 */
export async function buildTranscriptionWindows(
  ffmpegPath: string,
  ffprobePath: string,
  wavPath: string,
): Promise<Array<{ start: number; end: number }>> {
  const duration = await probeDuration(ffprobePath, wavPath);
  if (!(duration > 0)) {
    return [{ start: 0, end: Math.max(0.5, duration || 120) }];
  }

  const silences = await detectSilences(ffmpegPath, wavPath);
  const nonSilent = invertSilencesToRanges(silences, duration);
  const merged = mergeShortGaps(nonSilent, 0.25);
  const capped = capSegmentLength(merged, MAX_SEGMENT_SECONDS);
  return capped.length > 0 ? capped : [{ start: 0, end: duration }];
}

async function probeDuration(
  ffprobePath: string,
  file: string,
): Promise<number> {
  try {
    const cmd = `${ffprobePath} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`;
    const { stdout } = await execAsync(cmd);
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function detectSilences(
  ffmpegPath: string,
  wavPath: string,
): Promise<Array<{ start: number; end: number }>> {
  const cmd = `${ffmpegPath} -nostats -i "${wavPath}" -af silencedetect=noise=-35dB:d=0.35 -f null -`;
  let stderr = "";
  try {
    await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
  } catch (e: unknown) {
    // ffmpeg returns non-zero when decoding to null sink; stderr still has silencedetect lines
    stderr = extractStderr(e);
  }
  const silences: Array<{ start: number; end: number }> = [];
  const startRe = /silence_start:\s*([0-9.]+)/g;
  const endRe = /silence_end:\s*([0-9.]+)/g;
  const starts: number[] = [];
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(stderr)) !== null) starts.push(parseFloat(m[1]));
  while ((m = endRe.exec(stderr)) !== null) ends.push(parseFloat(m[1]));
  const pairs = Math.min(starts.length, ends.length);
  for (let i = 0; i < pairs; i++) {
    silences.push({ start: starts[i], end: ends[i] });
  }
  return silences;
}

function extractStderr(e: unknown): string {
  if (e && typeof e === "object" && "stderr" in e) {
    const s = (e as { stderr?: string }).stderr;
    return typeof s === "string" ? s : "";
  }
  return "";
}

function invertSilencesToRanges(
  silences: Array<{ start: number; end: number }>,
  duration: number,
): Array<{ start: number; end: number }> {
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start > cursor) {
      ranges.push({ start: cursor, end: Math.min(s.start, duration) });
    }
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) {
    ranges.push({ start: cursor, end: duration });
  }
  return ranges.filter((r) => r.end - r.start > 0.05);
}

function mergeShortGaps(
  ranges: Array<{ start: number; end: number }>,
  minGap: number,
): Array<{ start: number; end: number }> {
  if (ranges.length === 0) return [];
  const out: Array<{ start: number; end: number }> = [];
  let cur = { ...ranges[0] };
  for (let i = 1; i < ranges.length; i++) {
    const next = ranges[i];
    if (next.start - cur.end <= minGap) {
      cur.end = next.end;
    } else {
      out.push(cur);
      cur = { ...next };
    }
  }
  out.push(cur);
  return out;
}

function capSegmentLength(
  ranges: Array<{ start: number; end: number }>,
  maxLen: number,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    let s = r.start;
    while (s < r.end - 0.01) {
      const e = Math.min(r.end, s + maxLen);
      out.push({ start: s, end: e });
      s = e;
    }
  }
  return out;
}

export async function extractWavSegment(
  ffmpegPath: string,
  inputWav: string,
  outputPath: string,
  start: number,
  end: number,
): Promise<void> {
  const dur = Math.max(0.1, end - start);
  const cmd = `${ffmpegPath} -y -ss ${start.toFixed(3)} -i "${inputWav}" -t ${dur.toFixed(3)} -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}"`;
  await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
}

/** Test helper: export a tiny WAV via ffmpeg tone. */
export async function writeTestWav(
  ffmpegPath: string,
  outPath: string,
  seconds: number,
): Promise<void> {
  const cmd = `${ffmpegPath} -y -f lavfi -i "sine=frequency=440:duration=${seconds}" -ac 1 -ar 16000 "${outPath}"`;
  await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
}

export async function writeTestMp3(
  ffmpegPath: string,
  outPath: string,
  seconds: number,
): Promise<void> {
  const cmd = `${ffmpegPath} -y -f lavfi -i "sine=frequency=330:duration=${seconds}" -ac 1 -ar 44100 -c:a libmp3lame -q:a 6 "${outPath}"`;
  await execAsync(cmd, { maxBuffer: 50 * 1024 * 1024 });
}
