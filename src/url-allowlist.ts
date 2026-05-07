/**
 * Host allowlist for server-side audio URL fetches (TRANSCRIPT_MCP_URL_ALLOWLIST).
 * Comma-separated patterns; * wildcards supported.
 */

function patternToRegex(pattern: string): RegExp {
  const trimmed = pattern.trim().toLowerCase();
  const escaped = trimmed
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function parseUrlAllowlist(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

export function isHostnameAllowed(
  hostname: string,
  patterns: string[],
): boolean {
  const host = hostname.trim().toLowerCase();
  for (const p of patterns) {
    if (p.includes("*")) {
      if (patternToRegex(p).test(host)) return true;
    } else if (host === p.toLowerCase()) {
      return true;
    }
  }
  return false;
}
