import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { sessionDir, sessionDirs } from "../src/engine/session";

// TEMPORARY diagnostic, removed once the Linux-only ordering failure is understood.
test("diagnostic: what mtimes does this platform actually report", () => {
  const root = mkdtempSync(join(tmpdir(), "empo-diag-"));
  const one = sessionDir(root, "one");
  const two = sessionDir(root, "two");
  for (const dir of [one, two]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id: basename(dir) }), "utf8");
  }

  const past = Date.now() / 1000 - 60;
  utimesSync(join(one, "session.json"), past, past);

  const seconds = statSync(join(one, "session.json")).mtimeMs;
  const nowish = statSync(join(two, "session.json")).mtimeMs;
  const dated = new Date(Date.now() - 90_000);
  utimesSync(join(two, "session.json"), new Date(), dated);
  const byDate = statSync(join(two, "session.json")).mtimeMs;

  console.log(
    JSON.stringify({
      platform: process.platform,
      node: process.version,
      tmpdir: tmpdir(),
      numericArg: past,
      oneAfterNumeric: seconds,
      twoBefore: nowish,
      twoAfterDate: byDate,
      dateArg: dated.getTime(),
      readdir: readdirSync(join(tmpdir(), "empo-review")).filter((n) => n.includes("-")),
      sessionDirs: sessionDirs(root).map((d) => basename(d)),
    }),
  );

  expect(true).toBe(true);
});
