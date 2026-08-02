/**
 * Clause segmentation for streaming TTS: speech starts after the first
 * stable clause instead of after the entire controller response. Splits on
 * sentence boundaries, folding fragments that are too short to synthesize
 * well into their neighbor.
 */

const MIN_CLAUSE_CHARS = 24;
const MAX_CLAUSE_CHARS = 280;

export function splitIntoClauses(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  // Sentence-ish boundaries: ., !, ?, ;, : followed by whitespace. Avoids
  // splitting decimals ("3.5") and common abbreviations by requiring the
  // boundary to be followed by a space + capital/quote/digit-start.
  const parts = normalized
    .split(/(?<=[.!?;:])\s+(?=["'A-Z0-9(])/)
    .map((part) => part.trim())
    .filter(Boolean);

  const merged: string[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      (previous.length < MIN_CLAUSE_CHARS || part.length < MIN_CLAUSE_CHARS)
    ) {
      merged[merged.length - 1] = `${previous} ${part}`;
    } else {
      merged.push(part);
    }
  }

  // Long clauses split at comma boundaries so synthesis chunks stay bounded.
  const bounded: string[] = [];
  for (const clause of merged) {
    if (clause.length <= MAX_CLAUSE_CHARS) {
      bounded.push(clause);
      continue;
    }
    let rest = clause;
    while (rest.length > MAX_CLAUSE_CHARS) {
      const cut = rest.lastIndexOf(", ", MAX_CLAUSE_CHARS);
      if (cut < MIN_CLAUSE_CHARS) break;
      bounded.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 2);
    }
    bounded.push(rest);
  }
  return bounded;
}
