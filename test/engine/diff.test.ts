import { describe, expect, test } from "vitest";
import { changedLines, changedPaths, parseDiff } from "../../src/engine/diff";

/**
 * The parser turns a diff into the two things a review needs: which files changed and which line
 * numbers in them. Every input here is written one line per array entry, because a diff is made of
 * lines whose leading and trailing spaces are load-bearing and a template literal hides both.
 */
function diff(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

describe("parseDiff", () => {
  test("returns one file per header, sorted by code unit and not by locale", () => {
    // "Z" sorts before "a" by code unit and after it by locale, which is the whole reason the
    // engine has compareStrings. A diff that reorders itself between two machines is not diffable.
    const text = diff(
      "diff --git a/src/apple.ts b/src/apple.ts",
      "--- a/src/apple.ts",
      "+++ b/src/apple.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "diff --git a/src/Zebra.ts b/src/Zebra.ts",
      "--- a/src/Zebra.ts",
      "+++ b/src/Zebra.ts",
      "@@ -1 +1 @@",
      "-const z = 1;",
      "+const z = 2;",
      "diff --git a/src/beta.ts b/src/beta.ts",
      "--- a/src/beta.ts",
      "+++ b/src/beta.ts",
      "@@ -1 +1 @@",
      "-const b = 1;",
      "+const b = 2;",
    );

    expect(changedPaths(parseDiff(text))).toEqual(["src/Zebra.ts", "src/apple.ts", "src/beta.ts"]);
  });

  test("reads a hunk header with trailing context text", () => {
    const text = diff(
      "diff --git a/src/total.ts b/src/total.ts",
      "index 1111111..2222222 100644",
      "--- a/src/total.ts",
      "+++ b/src/total.ts",
      "@@ -12,3 +12,4 @@ export function total(): number {",
      "   const base = 1;",
      "-  const vat = 2;",
      "+  const vat = 3;",
      "+  const fee = 4;",
      "   return base;",
    );

    const file = parseDiff(text)[0];

    expect(file?.status).toBe("modified");
    expect(file?.hunks[0]).toMatchObject({
      oldStart: 12,
      oldLines: 3,
      newStart: 12,
      newLines: 4,
      added: [
        { line: 13, text: "  const vat = 3;" },
        { line: 14, text: "  const fee = 4;" },
      ],
      removed: [{ line: 13, text: "  const vat = 2;" }],
    });
    expect(file?.addedCount).toBe(2);
    expect(file?.removedCount).toBe(1);
  });

  test("treats an omitted hunk count as one line", () => {
    const text = diff(
      "diff --git a/src/one.ts b/src/one.ts",
      "--- a/src/one.ts",
      "+++ b/src/one.ts",
      "@@ -12 +12 @@",
      "-const a = 1;",
      "+const a = 2;",
    );

    expect(parseDiff(text)[0]?.hunks[0]).toMatchObject({
      oldStart: 12,
      oldLines: 1,
      newStart: 12,
      newLines: 1,
      added: [{ line: 12, text: "const a = 2;" }],
      removed: [{ line: 12, text: "const a = 1;" }],
    });
  });

  test("reports an added file, whose old side is /dev/null", () => {
    const text = diff(
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..e69de29",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export const answer = 42;",
    );

    const file = parseDiff(text)[0];

    expect(file?.path).toBe("src/new.ts");
    expect(file?.status).toBe("added");
    expect(file?.oldPath).toBeNull();
    expect(file?.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(file?.addedCount).toBe(1);
    expect(file?.removedCount).toBe(0);
  });

  test("reports a deleted file, keeping the name the diff header carries", () => {
    const text = diff(
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "index e69de29..0000000",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-const a = 1;",
      "-const b = 2;",
    );

    const file = parseDiff(text)[0];

    expect(file?.path).toBe("src/old.ts");
    expect(file?.status).toBe("deleted");
    expect(file?.removedCount).toBe(2);
    expect(file?.hunks[0]?.removed).toEqual([
      { line: 1, text: "const a = 1;" },
      { line: 2, text: "const b = 2;" },
    ]);
    // Nothing of it is left in the new file, so no citation can point inside it.
    expect(changedLines(file ?? emptyFile())).toEqual([]);
  });

  test("reports a rename with hunks, under its new path", () => {
    const text = diff(
      "diff --git a/src/old/name.ts b/src/new/name.ts",
      "similarity index 87%",
      "rename from src/old/name.ts",
      "rename to src/new/name.ts",
      "index 1111111..2222222 100644",
      "--- a/src/old/name.ts",
      "+++ b/src/new/name.ts",
      "@@ -3,2 +3,2 @@",
      " keep this;",
      "-was this;",
      "+is this now;",
    );

    const file = parseDiff(text)[0];

    expect(file?.path).toBe("src/new/name.ts");
    expect(file?.oldPath).toBe("src/old/name.ts");
    expect(file?.status).toBe("renamed");
    expect(file?.hunks[0]?.added).toEqual([{ line: 4, text: "is this now;" }]);
    expect(file?.hunks[0]?.removed).toEqual([{ line: 4, text: "was this;" }]);
  });

  test("reports a rename with no hunks at all", () => {
    const text = diff(
      "diff --git a/src/a.ts b/src/b.ts",
      "similarity index 100%",
      "rename from src/a.ts",
      "rename to src/b.ts",
    );

    expect(parseDiff(text)[0]).toMatchObject({
      path: "src/b.ts",
      oldPath: "src/a.ts",
      status: "renamed",
      hunks: [],
      addedCount: 0,
      removedCount: 0,
    });
  });

  test("reports a mode change with no hunks as a modification", () => {
    const text = diff("diff --git a/bin/run.sh b/bin/run.sh", "old mode 100644", "new mode 100755");

    expect(parseDiff(text)[0]).toMatchObject({
      path: "bin/run.sh",
      status: "modified",
      hunks: [],
      isBinary: false,
    });
  });

  test("marks a binary file and gives it no hunks", () => {
    const text = diff(
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      "diff --git a/assets/icon.png b/assets/icon.png",
      "new file mode 100644",
      "index 0000000..3333333",
      "Binary files /dev/null and b/assets/icon.png differ",
    );

    expect(parseDiff(text)).toMatchObject([
      { path: "assets/icon.png", status: "added", isBinary: true, hunks: [] },
      { path: "assets/logo.png", status: "modified", isBinary: true, hunks: [] },
    ]);
  });

  test("does not count the no-newline marker as a line", () => {
    const text = diff(
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      "\\ No newline at end of file",
      "+const b = 3;",
      "\\ No newline at end of file",
    );

    const file = parseDiff(text)[0];

    expect(file?.addedCount).toBe(1);
    expect(file?.removedCount).toBe(1);
    expect(file?.hunks[0]?.added).toEqual([{ line: 2, text: "const b = 3;" }]);
    expect(file?.hunks[0]?.removed).toEqual([{ line: 2, text: "const b = 2;" }]);
  });

  test("reads content that looks like diff structure, because the hunk counts bound it", () => {
    const text = diff(
      "diff --git a/src/flags.ts b/src/flags.ts",
      "--- a/src/flags.ts",
      "+++ b/src/flags.ts",
      "@@ -1,4 +1,6 @@",
      " const keep = 1;",
      // A zero-length line, which is what several tools emit instead of a single space for blank
      // context. Dropping it would shift every line number under it.
      "",
      "--- legacy flag",
      "+++ modern flag",
      "+@@ not a header",
      "+diff --git a/ghost.ts b/ghost.ts",
      " const tail = 2;",
    );

    const files = parseDiff(text);

    expect(files).toHaveLength(1);
    expect(files[0]?.hunks[0]?.removed).toEqual([{ line: 3, text: "-- legacy flag" }]);
    expect(files[0]?.hunks[0]?.added).toEqual([
      { line: 3, text: "++ modern flag" },
      { line: 4, text: "@@ not a header" },
      { line: 5, text: "diff --git a/ghost.ts b/ghost.ts" },
    ]);
    // The trailing context line sits after the blank one, so its number proves the blank counted.
    expect(files[0]?.hunks[0]).toMatchObject({ oldLines: 4, newLines: 6 });
  });

  test("keeps a path that contains spaces", () => {
    const text = diff(
      "diff --git a/src/dir with space/x.ts b/src/dir with space/x.ts",
      "--- a/src/dir with space/x.ts",
      "+++ b/src/dir with space/x.ts",
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      // No ---/+++ lines here, so the header is the only place this path exists.
      "diff --git a/assets/my logo.png b/assets/my logo.png",
      "Binary files a/assets/my logo.png and b/assets/my logo.png differ",
    );

    expect(changedPaths(parseDiff(text))).toEqual([
      "assets/my logo.png",
      "src/dir with space/x.ts",
    ]);
  });

  test("unquotes the quoted header form, octal escapes included", () => {
    const text = diff(
      'diff --git "a/dir with space/x.ts" "b/dir with space/x.ts"',
      '--- "a/dir with space/x.ts"',
      '+++ "b/dir with space/x.ts"',
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
      // Git writes every byte above ASCII in octal, and these two are one character together.
      'diff --git "a/src/caf\\303\\251/menu.ts" "b/src/caf\\303\\251/menu.ts"',
      '--- "a/src/caf\\303\\251/menu.ts"',
      '+++ "b/src/caf\\303\\251/menu.ts"',
      "@@ -1 +1 @@",
      "-const a = 1;",
      "+const a = 2;",
    );

    expect(changedPaths(parseDiff(text))).toEqual(["dir with space/x.ts", "src/café/menu.ts"]);
  });

  test("runs the line numbers on per hunk, not across the file", () => {
    const text = diff(
      "diff --git a/src/multi.ts b/src/multi.ts",
      "--- a/src/multi.ts",
      "+++ b/src/multi.ts",
      "@@ -1,3 +1,4 @@",
      " one",
      "+two",
      " three",
      " four",
      "@@ -20,3 +21,4 @@ function tail() {",
      " twenty",
      "+twentyone",
      " twentytwo",
      " twentythree",
    );

    const file = parseDiff(text)[0];

    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]?.added).toEqual([{ line: 2, text: "two" }]);
    expect(file?.hunks[1]?.added).toEqual([{ line: 22, text: "twentyone" }]);
    expect(file?.addedCount).toBe(2);
  });

  test("answers which new-file lines the change covers", () => {
    const text = diff(
      "diff --git a/src/multi.ts b/src/multi.ts",
      "--- a/src/multi.ts",
      "+++ b/src/multi.ts",
      "@@ -1,3 +1,4 @@",
      " one",
      "+two",
      " three",
      " four",
      "@@ -20,3 +21,4 @@",
      " twenty",
      "+twentyone",
      " twentytwo",
      " twentythree",
    );

    const file = parseDiff(text)[0] ?? emptyFile();

    // Only the lines the diff wrote, which is what a citation outside the diff is measured against.
    expect(changedLines(file)).toEqual([2, 22]);
  });

  test("returns nothing for input that is not a diff, instead of throwing", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("just some prose\nnot a diff at all\n")).toEqual([]);
    expect(parseDiff("@@ -1,2 +1,2 @@\n-a\n+b\n")).toEqual([]);
    expect(parseDiff("diff --git nonsense\n")).toEqual([]);
    expect(parseDiff("\u0000binary noise\u0000")).toEqual([]);
  });

  test("keeps the file when a hunk inside it is unreadable", () => {
    const text = diff(
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ this is not a hunk header @@",
      "+orphan",
    );

    expect(parseDiff(text)).toMatchObject([{ path: "src/x.ts", hunks: [], addedCount: 0 }]);
  });
});

/** A stand-in so a helper under test is never handed `undefined` when an index lookup fails. */
function emptyFile() {
  return {
    path: "",
    oldPath: null,
    status: "modified" as const,
    hunks: [],
    addedCount: 0,
    removedCount: 0,
    isBinary: false,
  };
}
