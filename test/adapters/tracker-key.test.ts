import { describe, expect, test } from "vitest";
import { extractKeyFrom } from "../../src/adapters/tracker/key";
import type { KeySource } from "../../src/adapters/tracker/types";

/**
 * The capture-group half of key extraction. Jira and Linear put one identical string in the branch
 * and the title, so the whole match is the key and nothing here matters. Asana has no typeable key
 * at all: the branch carries a bare gid and the pull request carries a permalink, so the pattern has
 * to reduce two different strings to the same identifier. That is what the groups are for.
 */
function source(parts: Partial<KeySource>): KeySource {
  return { branch: "", title: "", body: "", ...parts };
}

/**
 * The three permalink shapes Asana serves today plus a bare gid, in one alternation. Most of its
 * groups are empty on any given match, which is why "first non-empty group" is the rule and "group
 * 1" is not.
 */
const ASANA =
  "app\\.asana\\.com/(?:1/\\d+/(?:project/\\d+/|home/)?task/(\\d+)|0/\\d+/(\\d+))|(?<!\\d)(\\d{10,25})(?!\\d)";

const GID = "1234567890123456";

describe("extractKeyFrom capture groups", () => {
  test("returns the whole match for a pattern with no groups, as the default has none", () => {
    expect(extractKeyFrom(source({ title: "PLAT-1234 add the export" }))?.key).toBe("PLAT-1234");
  });

  test("returns the group rather than the whole match when the pattern has one", () => {
    const match = extractKeyFrom(
      source({ title: `see https://app.asana.com/1/1122334455/project/998877/task/${GID}` }),
      "task/(\\d+)",
    );

    // The identifier, not the URL: every Asana tool takes a bare gid.
    expect(match?.key).toBe(GID);
  });

  test("returns the first non-empty group when the winning branch of an alternation is not the first", () => {
    // The legacy /0/<project>/<task> permalink matches group 2, leaving group 1 undefined.
    const match = extractKeyFrom(
      source({ title: `fixed by https://app.asana.com/0/998877/${GID}` }),
      ASANA,
    );

    expect(match?.key).toBe(GID);
  });

  test("reduces a subtask permalink with no project segment to the gid", () => {
    const match = extractKeyFrom(
      source({ title: `https://app.asana.com/1/1122334455/task/${GID}` }),
      ASANA,
    );

    expect(match?.key).toBe(GID);
  });

  test("reduces a bare branch gid to the same key as the title's permalink", () => {
    const match = extractKeyFrom(
      source({
        branch: `fix/${GID}-login-bug`,
        title: `Fix the login bug https://app.asana.com/1/1122334455/project/998877/task/${GID}`,
      }),
      ASANA,
    );

    expect(match?.key).toBe(GID);
    expect(match?.branchKey).toBe(GID);
    // The whole point: a branch and a title naming one task must not be reported as naming two.
    expect(match?.disagrees).toBe(false);
  });

  test("still disagrees when the branch gid and the title permalink are different tasks", () => {
    const match = extractKeyFrom(
      source({
        branch: "fix/1234567890123457-login-bug",
        title: `Fix the login bug https://app.asana.com/1/1122334455/project/998877/task/${GID}`,
      }),
      ASANA,
    );

    expect(match?.key).toBe(GID);
    expect(match?.branchKey).toBe("1234567890123457");
    expect(match?.disagrees).toBe(true);
  });

  test("keeps a gid a string, so one past MAX_SAFE_INTEGER survives digit for digit", () => {
    // Today's gids sit below MAX_SAFE_INTEGER, so nothing is corrupt yet. This pins the behaviour
    // for the length Asana is growing into, where a round trip through a number silently rewrites
    // the last digits and the review then fetches a task nobody asked for.
    const big = "1234567890123456789";
    const match = extractKeyFrom(source({ title: `https://app.asana.com/0/998877/${big}` }), ASANA);

    expect(match?.key).toBe(big);
    expect(String(Number(big))).not.toBe(big);
  });

  test("falls back to the whole match when a pattern has groups but none of them matched", () => {
    // `(x)?` participates in no match here. Falling back beats returning nothing.
    expect(extractKeyFrom(source({ title: "ENG-42" }), "(x)?ENG-\\d+")?.key).toBe("ENG-42");
  });

  test("returns null when a group matches empty and there is nothing else to use", () => {
    expect(extractKeyFrom(source({ title: "ENG-42" }), "()")).toBeNull();
  });
});
