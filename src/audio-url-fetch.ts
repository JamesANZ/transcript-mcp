import type { Config } from "./config.js";
import { parseUrlAllowlist, isHostnameAllowed } from "./url-allowlist.js";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface FetchedAudio {
  buffer: Buffer;
  filenameHint: string;
}

export async function fetchAudioFromUrl(
  urlString: string,
  config: Config,
): Promise<FetchedAudio> {
  const patterns = parseUrlAllowlist(config.transcriptMcpUrlAllowlist);
  if (patterns.length === 0) {
    throw new Error(
      "audio_url is disabled: TRANSCRIPT_MCP_URL_ALLOWLIST is empty. Set it to a comma-separated list of host patterns (e.g. \"*.amazonaws.com,localhost\") to allow server-side fetches.",
    );
  }

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid audio_url: not a valid URL.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(
      `Unsupported audio_url scheme "${url.protocol}". Only http(s) is allowed.`,
    );
  }

  if (!isHostnameAllowed(url.hostname, patterns)) {
    throw new Error(
      `audio_url host "${url.hostname}" is not allowed by TRANSCRIPT_MCP_URL_ALLOWLIST. Allowed patterns: ${patterns.join(", ")}`,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(urlString, {
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`audio_url fetch failed: HTTP ${res.status} ${res.statusText}`);
    }

    const cl = res.headers.get("content-length");
    if (cl) {
      const n = parseInt(cl, 10);
      if (!Number.isNaN(n) && n > DEFAULT_MAX_BYTES) {
        throw new Error(
          `audio_url response is too large (${n} bytes). Maximum is ${DEFAULT_MAX_BYTES} bytes.`,
        );
      }
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.length > DEFAULT_MAX_BYTES) {
      throw new Error(
        `audio_url payload is ${buffer.length} bytes; maximum is ${DEFAULT_MAX_BYTES} bytes.`,
      );
    }

    const cd = res.headers.get("content-disposition");
    let filenameHint = "downloaded-audio.bin";
    if (cd) {
      const m = cd.match(/filename\*?=(?:UTF-8'')?("?)([^";]+)\1/i);
      if (m?.[2]) filenameHint = decodeURIComponent(m[2]);
    } else {
      const pathLast = url.pathname.split("/").pop();
      if (pathLast && pathLast.includes(".")) filenameHint = pathLast;
    }

    return { buffer, filenameHint };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        `audio_url fetch timed out after ${DEFAULT_TIMEOUT_MS / 1000}s.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}
