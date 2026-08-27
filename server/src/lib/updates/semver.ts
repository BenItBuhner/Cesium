/**
 * Minimal semver parsing and comparison (with prerelease precedence per the
 * semver 2.0.0 spec). Deliberately dependency-free - the update checker only
 * needs ordering and tag normalization, not ranges.
 */

export type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  raw: string;
};

const SEMVER_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(input: string): ParsedSemver | null {
  const trimmed = input.trim();
  const match = SEMVER_PATTERN.exec(trimmed);
  if (!match) return null;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw: trimmed.replace(/^v/, ""),
  };
}

function comparePrereleaseIdentifiers(
  a: Array<string | number>,
  b: Array<string | number>
): number {
  // A version without prerelease identifiers ranks higher than one with them.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (typeof left === "number" && typeof right === "number") {
      if (left !== right) return left < right ? -1 : 1;
      continue;
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
}

/** True when `candidate` is a strictly newer semver than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parsedCandidate = parseSemver(candidate);
  const parsedCurrent = parseSemver(current);
  if (!parsedCandidate || !parsedCurrent) return false;
  return compareSemver(parsedCandidate, parsedCurrent) > 0;
}
