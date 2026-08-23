import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../../src/engine/git";
import { scanRoot } from "../../src/engine/scanner";

/**
 * The scan drops what git ignores. This is the rule that keeps `empo index` from reading a tree
 * nobody named in the config: a Laravel checkout's `storage/framework/phpstan` is thousands of
 * generated `.php` files, every one of them gitignored, and `scanRoot` holds every source it reads
 * in memory at once.
 */
describe("scanRoot", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "empo-scan-"));
    mkdirSync(join(repo, "app"));
    mkdirSync(join(repo, "storage"), { recursive: true });
    writeFileSync(join(repo, "app", "Order.php"), "<?php class Order {}");
    writeFileSync(join(repo, "storage", "cache.php"), "<?php // generated");
    writeFileSync(join(repo, ".gitignore"), "/storage/\n");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function scan(): string[] {
    return scanRoot({
      repoRoot: repo,
      root: { path: ".", lang: "php" },
      extensions: [".php"],
    }).map((file) => file.file);
  }

  test("reads everything the pack owns when nothing is a checkout", () => {
    // No `git init`, so the question has no answer and nothing is dropped.
    expect(scan()).toEqual(["app/Order.php", "storage/cache.php"]);
  });

  test("drops a file git ignores, and keeps the rest", () => {
    expect(run(repo, "git", ["init"]).ok).toBe(true);

    expect(scan()).toEqual(["app/Order.php"]);
  });
});
