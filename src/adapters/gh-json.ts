/**
 * Reading `gh --json` output, for every adapter that shells out to gh.
 *
 * This JSON comes from outside the process, so nothing here trusts a shape: a missing or wrongly
 * typed field coerces to the empty value rather than throwing, because a malformed answer has to
 * degrade the review the same way a failed call does (docs/09-adapters.md). The forge and the
 * github-issues tracker each grew their own copy of these four under different names; one copy
 * cannot drift from itself.
 *
 * What deliberately stays out: the per-adapter fallbacks that look like coercions and are not.
 * `login` in forge/github.ts reads an absent author as `"unknown"` because a review comment always
 * had someone behind it, while the tracker reads one as `""`. Folding those together would change
 * what a report prints.
 */

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The whole `gh --json` answer, or null when it is not JSON or not an object. */
export function readObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
