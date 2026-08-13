import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compareStrings } from "../../src/engine/order";
import { installedPacks, loadPack } from "../../src/engine/pack-loader";

/**
 * The pin under `graphDrift`, which is the gap where a pack can change behaviour without moving its
 * version. `graphDrift` in engine/graph.ts compares the pack version a graph recorded when it was
 * built against the version on disk now, and that comparison is the only thing in this tool that
 * tells a repository its answers predate a pack change. Nothing checked that an edit to pack.json
 * moved the version, so the whole guarantee rested on whoever edited the file remembering.
 * Measured: the typescript pack sat at 1.0.0 through four behaviour-changing edits, one of which
 * added four extensions to `match` and therefore changed which files are in the graph at all, and
 * every graph built before those edits reported no drift and was wrong to.
 *
 * So the version is checked mechanically here instead, in the shape docs/04-language-packs.md
 * already uses for derivable rules: hash what the pack means to the engine, record the hash beside
 * the version it was true of, and fail when the hash moves and the version does not.
 *
 * **What is hashed is the parsed pack from the real `loadPack`, not the bytes of pack.json.** A
 * field the schema does not declare is stripped at load, so it reaches no engine code and can change
 * no answer, and demanding a version bump for it would be demanding one for nothing. The inverse
 * matters more: pack.json writes one rule per line, so reflowing three rules onto four lines each
 * rewrites every byte of them and changes no behaviour, and a byte hash would bill that as a
 * behaviour change. A bump demanded for a reformat is how an editor learns to bump reflexively,
 * which costs exactly the signal this exists to give. Hashing the parse also catches the case
 * pack.json cannot show at all: a field added to pack.schema.ts starts feeding the engine a value it
 * previously dropped, the hash moves, and no line of the pack changed.
 *
 * **`version` is the only field excluded**, because it is the claim under test rather than part of
 * the behaviour it claims about. Nothing else in the schema is decoration. `name` cannot move on its
 * own, since `loadPack` refuses a pack whose name disagrees with its directory. Every other field
 * the schema declares is read by code somewhere, `aliasSources` by `empo init` rather than by the
 * graph build, and no second exclusion is to be added for a field that
 * looks inert: an exclusion written for a field somebody later wires up puts that day straight back
 * into "whoever remembers", which is the failure being closed here. The design errs toward one bump
 * nobody needed rather than one stale answer nobody hears about, the same direction `commitsAhead`
 * picks when it returns null rather than zero.
 *
 * The canonical form sorts object keys with `compareStrings`, never `localeCompare`, which is banned
 * here because it disagrees with itself across ICU builds and this hash is checked in. Arrays keep
 * their declared order, because order is semantic in a pack: the first matching kindRule wins and
 * the first resolvable extension wins, so a reordered list is a changed pack.
 *
 * The packs come from `installedPacks()` rather than a literal ["php", "typescript"], so a third
 * pack is pinned the day it lands rather than the day somebody remembers this file exists.
 *
 * The pairs were recorded from the packs as they stood, which makes this honest from here on and
 * not retroactively. One unbumped edit is already inside php's recorded 1.5.0: f830b49
 * put `arrivedBy: "user"` on three of its kindRules after c508feb had shipped 1.5.0, and it is left
 * unbumped on purpose rather than corrected into the record. `arrivedBy` is read at answer time by
 * `kindAxes` off the pack on disk, exactly as `resolvedBy` is, so no graph holds a copy of it to go
 * stale: a graph built before that edit answers identically to one built after. A bump would report
 * drift on every php graph in existence and the reindex it asked for would repair nothing, which is
 * the one shape of false alarm this pin must not manufacture. What the pin buys is the next such
 * edit, which will not get to be invisible.
 */

/** Read with a URL rather than a cwd-relative path; the display form is for the failure message. */
const RECORD = fileURLToPath(new URL("./versions.json", import.meta.url));
const RECORD_DISPLAY = "test/packs/versions.json";

interface RecordedPack {
  version: string;
  hash: string;
}

/**
 * The recorded pairs live in a data file next to this spec, not in a const at the top of it, so the
 * diff of a real pack edit reads as three files saying one thing: pack.json changed, its version
 * line moved, and one line of data moved with it. Not one line of the gate appears in that diff,
 * which is the point. A pin whose data and logic share a file can be loosened in the same commit
 * that trips it, and a reviewer reading a pack change would have no reason to look.
 */
function readRecord(): Record<string, RecordedPack> {
  return JSON.parse(readFileSync(RECORD, "utf8"));
}

/** Every field the engine reads out of a parsed pack, which is all of them except its version. */
function behaviouralFields(pack: object): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pack)) {
    if (key !== "version") fields[key] = value;
  }
  return fields;
}

/**
 * One string per pack value, with keys in code-unit order and absent optionals absent rather than
 * spelled null, so a pack that omits `hazards` hashes like one that omits `hazards`. `JSON.stringify`
 * does the escaping for the leaves and nothing else, since its object output follows insertion order
 * and two machines can reach the same pack through different insertion orders.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value)
    .filter(([, held]) => held !== undefined)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([key, held]) => `${JSON.stringify(key)}:${canonical(held)}`);

  return `{${entries.join(",")}}`;
}

/** Takes a parsed pack rather than a name, so a test below can hash a pack it altered by hand. */
function hashOf(pack: object): string {
  return createHash("sha256")
    .update(canonical(behaviouralFields(pack)))
    .digest("hex");
}

/**
 * The failure message is the product here, so it is built from what actually moved rather than
 * printed as one sentence covering four states. An editor who trips this is mid pack edit and needs
 * to be told which of the four they are in, what goes silent if they walk past it, and the exact
 * line to paste, in the house style of `empo pack test`: name every difference, then the command.
 */
function explain(name: string, recorded: RecordedPack | undefined, actual: RecordedPack): string {
  const moved = recorded !== undefined && actual.hash !== recorded.hash;
  const bumped = recorded !== undefined && actual.version !== recorded.version;
  const lines = [""];

  if (recorded === undefined) {
    lines.push(
      `${name}: installed, with no pair recorded, so nothing here checks that its version moves`,
      "when it changes. Record it, and from then on an edit that forgets the version fails:",
    );
  } else if (moved && !bumped) {
    lines.push(
      `${name}: its behavioural fields changed while its version stayed at ${recorded.version}.`,
      `  recorded  ${recorded.hash}`,
      `  computed  ${actual.hash}`,
      "",
      "graphDrift (src/engine/graph.ts) compares the version a graph was built with against the",
      "version on disk. It is the only thing that tells a repository its answers predate a pack",
      `change, so left at ${recorded.version} every graph built before this edit reports no drift`,
      "and is wrong to.",
      "",
      `Bump "version" in src/packs/${name}/pack.json, then record the new pair:`,
    );
  } else if (moved) {
    lines.push(
      `${name}: it changed and its version moved with it, which is the whole rule. Record the pair:`,
    );
  } else {
    lines.push(
      `${name}: its version moved to ${actual.version} with no behavioural field changed, which is`,
      "allowed and reports drift nobody needed. Record it, or this message names a stale version",
      "the next time a real edit trips it:",
    );
  }

  lines.push(
    "",
    `  ${RECORD_DISPLAY}`,
    `    ${JSON.stringify(name)}: ${JSON.stringify(actual)}`,
    "",
  );
  return lines.join("\n");
}

describe("every shipped pack's version tracks its behaviour", () => {
  const record = readRecord();
  const installed = installedPacks();

  test("records one pair per installed pack, so a new pack is pinned the day it lands", () => {
    // Deliberately the whole set rather than a lookup per pack: a pack added with no pair recorded
    // would otherwise be a pack this file silently does not cover, which is the state it exists to
    // end. installedPacks() already sorts with compareStrings.
    expect(Object.keys(record).sort(compareStrings)).toEqual(installed);
  });

  for (const name of installed) {
    test(`${name} matches the hash recorded against its version`, () => {
      // An unrecorded pack fails here as well as in the test above rather than being skipped as
      // "nothing to compare", because this is the test whose message can hand over the hash to
      // paste, and a pack landing with no pair is the one moment when somebody is looking.
      const pack = loadPack(name);
      const actual = { version: pack.version, hash: hashOf(pack) };

      expect(actual, explain(name, record[name], actual)).toEqual(record[name]);
    });
  }

  test("hashes the same pack to the same string twice, since the record is checked in", () => {
    // Cheap, and it is the property the whole file rests on: an unstable hash would demand a bump on
    // every run and be turned off within the day.
    for (const name of installed) expect(hashOf(loadPack(name))).toBe(hashOf(loadPack(name)));
  });

  test("moves the hash when a behavioural field moves, and not when the version does", () => {
    // The pin's own pin. Nothing above proves the hash is sensitive to anything at all, and a hash
    // of a constant would satisfy every assertion in this file forever. Both directions are asserted
    // against a shipped pack: widening `match` changes which files are in the graph, which is the
    // very edit that was measured going unversioned, and a version alone must not answer for it.
    const [first = "php"] = installed;
    const pack = loadPack(first);
    const extensions = [...pack.match.extensions, ".empo-probe"];

    expect(hashOf({ ...pack, match: { ...pack.match, extensions } })).not.toBe(hashOf(pack));
    expect(hashOf({ ...pack, version: "9.9.9" })).toBe(hashOf(pack));
  });
});
