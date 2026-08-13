# `symbol` Node-Id Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `symbol` node-id strategy (`path#exportName`) in the engine and adopt it in the TypeScript pack, so a blast radius over TypeScript answers per export instead of per file.

**Architecture:** A pack declaring `strategy: "symbol"` also declares `symbolPattern`, a regex whose group 1 is an exported name. Top-level matches partition the file into line extents. A file with at least one match yields one node per symbol and **no** module node; a file with none yields exactly the module node it yields today, so nothing about `fqcn` or `module-path` packs changes. Extraction — the only layer holding the source text — attributes every capture and every produced/consumed symbol ref to the symbols that own it, so the resolver stays source-free. Import edges gain a target per bound name.

**Tech Stack:** TypeScript 7 (ESM, `node:` builtins), vitest, biome, zod 4 for schemas, picomatch.

## Global Constraints

- Node `>=22.12.0`, ESM only, `"type": "module"`. Imports of builtins use the `node:` prefix.
- No new runtime dependencies. Existing ones only: commander, execa, picomatch, tinyglobby, zod.
- `npm test`, `npm run check` (biome) and `npm run typecheck` (tsc `--noEmit`) must all pass at every commit.
- Determinism is a hard requirement: two runs over the same bytes write byte-identical `graph.json`. Every new collection is sorted with `compareStrings` from `src/engine/order.ts` before it reaches the graph.
- Every claim printed by a command carries a `file:line` citation. Nothing added here may print a claim without one.
- Comments in this codebase explain *why*, at length, in prose. Match that register; do not add restating comments.
- `fixtures/` is excluded from the repo's own toolchain (biome, vitest, tsc). Do not add fixture paths to any config.
- Prose rule enforced by review: no em-dashes in code comments or docs added here.

---

### Task 1: The pack contract — `symbolPattern`, and a refusal that survives

A pack declaring `symbol` today is refused outright at compile time. That refusal becomes narrower: it now refuses only a pack that declares `symbol` **without** a `symbolPattern`, because that pack has named a strategy and given the engine no way to find a symbol.

**Files:**
- Modify: `src/schema/pack.schema.ts` (the `node.id` object, near line 434 where `strategy` is declared)
- Modify: `src/schema/types.ts` (the `NodeId` interface)
- Modify: `src/engine/extractor.ts:160-186` (`refuseUnbuiltIdStrategy`)
- Test: `test/engine/extractor.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NodeId.symbolPattern?: string`. Task 2 compiles it into `CompiledPack.symbolRegex?: RegExp`.

- [ ] **Step 1: Write the failing tests**

In `test/engine/extractor.test.ts`:

```ts
it("refuses a symbol pack that declares no symbolPattern", () => {
  const pack = packWith({ node: { id: { strategy: "symbol" } } });
  expect(() => compilePack(pack)).toThrow(/symbolPattern/);
});

it("compiles a symbol pack that declares one", () => {
  const pack = packWith({
    node: { id: { strategy: "symbol", symbolPattern: "^export\\s+(?:const|function)\\s+([A-Za-z0-9_$]+)" } },
  });
  expect(() => compilePack(pack)).not.toThrow();
});
```

Use the existing pack-building helper in that file if one exists; otherwise build the object literally from `src/packs/typescript/pack.json` with the `node.id` block replaced.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/engine/extractor.test.ts`
Expected: both FAIL, the second with `node id strategy "symbol" is not implemented yet`.

- [ ] **Step 3: Add the field to the schema and the type**

In `src/schema/types.ts`, on the `NodeId` interface:

```ts
  /**
   * How a `symbol`-strategy pack finds one exported symbol. Group 1 is the name. Declared by that
   * strategy and by no other, because it is the only one whose ids are not derivable from the path
   * or from a single class declaration.
   */
  symbolPattern?: string;
```

In `src/schema/pack.schema.ts`, beside the other `node.id` keys, add `symbolPattern: z.string().optional()`, matching the surrounding style (the file uses `.optional()` on every non-required key and refuses unknown keys, so the key must be declared or a pack carrying it is rejected).

- [ ] **Step 4: Rewrite the refusal**

Replace `refuseUnbuiltIdStrategy` in `src/engine/extractor.ts` with:

```ts
/**
 * A pack naming `symbol` must also say how a symbol is found, because that strategy is the only one
 * whose ids are not derivable from what the engine already reads: `fqcn` reads one class declaration
 * and `module-path` reads the path. Without a pattern the pack has named a granularity and handed
 * the engine no way to reach it, and the honest answer is to refuse the pack rather than to fall back
 * to the file-level node the other two strategies produce, which would answer every later question
 * about that root with ids the pack did not ask for.
 *
 * It is raised at compile time, once, before a single file is read, and it names the pack that asked.
 */
function refuseIncompleteIdStrategy(pack: Pack): void {
  if (pack.node.id.strategy !== "symbol") return;
  if (pack.node.id.symbolPattern !== undefined) return;
  throw configError(`node id strategy "symbol" needs a symbolPattern`, [
    `The "${pack.name}" pack declares the strategy and no pattern to find a symbol by.`,
    "symbolPattern is a regex over the file's source whose group 1 is the exported name.",
    "See docs/04-language-packs.md, section 2.",
  ]);
}
```

Update the call site at line 124 to the new name.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/engine/extractor.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schema/pack.schema.ts src/schema/types.ts src/engine/extractor.ts test/engine/extractor.test.ts
git commit -m "Let a symbol pack say how a symbol is found"
```

---

### Task 2: Symbol extents in extraction

One file yields a list of symbols, each with a name and a line range. This task adds the list and the ranges and nothing else: no node yet changes shape downstream.

**Files:**
- Modify: `src/engine/extractor.ts`
- Test: `test/engine/extractor.test.ts`

**Interfaces:**
- Consumes: `CompiledPack` from Task 1.
- Produces:
  ```ts
  export interface ExtractedSymbol {
    /** The exported name, group 1 of the pack's symbolPattern. */
    name: string;
    /** `<repo-relative file>#<name>`. */
    id: string;
    /** 1-based, inclusive. */
    startLine: number;
    /** 1-based, inclusive. Runs to the last line of the file for the final symbol. */
    endLine: number;
  }
  ```
  and `ExtractedFile.symbols: ExtractedSymbol[]` (empty for every non-`symbol` pack). Tasks 3, 4 and 5 read it.

- [ ] **Step 1: Write the failing test**

```ts
const SOURCE = [
  'import { formatMoney } from "./money";',   // 1
  "",                                          // 2
  "export function total(items) {",            // 3
  "  return formatMoney(items);",              // 4
  "}",                                         // 5
  "",                                          // 6
  "export const LABEL = 'x';",                 // 7
].join("\n");

it("partitions a file into one extent per exported symbol", () => {
  const file = extractFile(symbolPack(), scannedFrom("apps/web/src/total.ts", SOURCE));
  expect(file?.symbols).toEqual([
    { name: "total", id: "apps/web/src/total.ts#total", startLine: 3, endLine: 6 },
    { name: "LABEL", id: "apps/web/src/total.ts#LABEL", startLine: 7, endLine: 7 },
  ]);
});

it("yields no symbols for a pack that declares no symbolPattern", () => {
  const file = extractFile(modulePathPack(), scannedFrom("apps/web/src/total.ts", SOURCE));
  expect(file?.symbols).toEqual([]);
});

it("keeps two exports of one name as one symbol", () => {
  // A file cannot export one name twice; if a pattern matches it twice the first wins, so an id is
  // never duplicated inside one file.
  const source = "export const a = 1;\nexport const a = 2;\n";
  const file = extractFile(symbolPack(), scannedFrom("x.ts", source));
  expect(file?.symbols.map((s) => s.id)).toEqual(["x.ts#a"]);
});
```

`symbolPack()` is the TypeScript pack with `node.id` replaced by
`{ strategy: "symbol", symbolPattern: "^export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var|type|interface|enum)\\s+([A-Za-z0-9_$]+)", indexNames: ["index"] }`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/engine/extractor.test.ts -t "extent"`
Expected: FAIL, `symbols` is undefined.

- [ ] **Step 3: Compile the pattern**

In `compilePack`, add to the returned object:

```ts
    symbolRegex: optionalRegex(pack.node.id.symbolPattern, "gm"),
```

and widen `optionalRegex` to take flags, defaulting to `"m"` so its two existing callers are unchanged:

```ts
function optionalRegex(pattern: string | undefined, flags = "m"): RegExp | undefined {
  return pattern === undefined ? undefined : new RegExp(pattern, flags);
}
```

Add `symbolRegex?: RegExp;` to `CompiledPack`.

- [ ] **Step 4: Find the extents**

Add to `src/engine/extractor.ts`:

```ts
/**
 * The symbols one file exports, each holding the lines from its own declaration to the line before
 * the next one. A file is partitioned rather than parsed, which is the whole bargain of this engine:
 * every rule in it is a regex over masked text, and a real scope tree would need a parser per
 * language, which is the thing a language-agnostic pack contract exists to avoid.
 *
 * What makes the partition safe enough to answer with is the pack's pattern, not this function. A
 * pattern anchored at `^` matches only a declaration written at column 0, and every language this
 * strategy suits indents a nested declaration, so a function declared inside another function does
 * not open an extent of its own. That is a real ceiling and it is stated in docs/04-language-packs.md
 * rather than hidden here: text between two exports belongs to the earlier one, so a helper written
 * at column 0 between two exports is read as part of the export above it.
 *
 * ponytail: line partition, no brace balancing. Upgrade to hazards.ts's `balancedEnd` if a pack
 * appears whose declarations are not written at column 0.
 */
function extractSymbolExtents(
  regex: RegExp | undefined,
  source: string,
  file: string,
  starts: number[],
): ExtractedSymbol[] {
  if (regex === undefined) return [];

  const found: { name: string; startLine: number }[] = [];
  const seen = new Set<string>();
  for (const match of matchAll(regex, source)) {
    const name = match.groups[1];
    // A pattern that matches and captures nothing is the pack's own bug and not a declaration, the
    // same bargain `declaredNames` makes above.
    if (name === undefined || name === "" || seen.has(name)) continue;
    seen.add(name);
    found.push({ name, startLine: lineAt(starts, match.index) });
  }

  const lastLine = starts.length;
  return found.map((entry, position) => ({
    name: entry.name,
    id: `${file}#${entry.name}`,
    startLine: entry.startLine,
    endLine: (found[position + 1]?.startLine ?? lastLine + 1) - 1,
  }));
}
```

Export the `ExtractedSymbol` interface from the same module.

- [ ] **Step 5: Hand it to the file**

In `extractFile`, after `const starts = lineStarts(source);`, add

```ts
  const symbols = extractSymbolExtents(compiled.symbolRegex, source, scanned.file, starts);
```

and add `symbols,` to the returned object. Add `symbols: ExtractedSymbol[];` to `ExtractedFile` with a comment saying it is empty for every pack that declares no `symbolPattern`, which is every pack whose strategy is not `symbol`.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npx vitest run test/engine/extractor.test.ts && npm run typecheck`
Expected: PASS, and every pre-existing test in the file still passes because `symbols` is `[]` for both shipped packs.

- [ ] **Step 7: Commit**

```bash
git add src/engine/extractor.ts test/engine/extractor.test.ts
git commit -m "Read the extent of every exported symbol"
```

---

### Task 3: Attribute captures and symbol refs to their owners

A capture belongs to the symbol whose extent holds its line. An import statement sits above every extent and belongs to none, so it is attributed instead to the symbols that reference a name it binds. This is what stops one file's imports from smearing across all of its exports.

**Files:**
- Modify: `src/engine/extractor.ts`
- Test: `test/engine/extractor.test.ts`

**Interfaces:**
- Consumes: `ExtractedSymbol` from Task 2.
- Produces: `Capture.owners?: string[]` and `SymbolRef.owners?: string[]`, both **absent** for a non-`symbol` pack and both meaning, when absent, "every node this file yields". Task 4 reads `Capture.owners`; Task 5 reads `SymbolRef.owners`.

- [ ] **Step 1: Write the failing test**

```ts
it("gives an import to the exports that reference what it binds", () => {
  const source = [
    'import { formatMoney } from "./money";',
    'import { parseMoney } from "./parse";',
    "",
    "export function total(items) {",
    "  return formatMoney(items);",
    "}",
    "",
    "export const LABEL = 'x';",
  ].join("\n");
  const file = extractFile(symbolPack(), scannedFrom("src/total.ts", source));
  const byLine = new Map(file!.captures.map((c) => [c.line, c.owners]));
  expect(byLine.get(1)).toEqual(["src/total.ts#total"]);
  // Nothing references parseMoney, so no export can be said to be the one that needs it.
  expect(byLine.get(2)).toEqual(["src/total.ts#total", "src/total.ts#LABEL"]);
});

it("gives a capture inside an extent to that symbol alone", () => {
  const source = [
    "export function a() {",
    '  return fetch("/api/one");',
    "}",
    "export function b() {}",
  ].join("\n");
  const file = extractFile(symbolPack(), scannedFrom("src/x.ts", source));
  expect(file!.consumes[0]?.owners).toEqual(["src/x.ts#a"]);
});

it("leaves owners absent for a module-path pack", () => {
  const file = extractFile(modulePathPack(), scannedFrom("src/x.ts", 'import "./y";'));
  expect(file!.captures[0]?.owners).toBeUndefined();
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/engine/extractor.test.ts -t "owners"`
Expected: FAIL, `owners` is undefined on every capture.

- [ ] **Step 3: Add the fields**

On `Capture` in `src/engine/extractor.ts` and on `SymbolRef` in `src/schema/types.ts`:

```ts
  /**
   * The nodes this belongs to, for a pack whose file yields more than one. Absent where the file
   * yields a single node, which is every file of a `fqcn` or `module-path` pack: "all of them" and
   * "the only one" are the same answer there, and writing it out would put a node id in `graph.json`
   * for every capture of every pack that never asked for one.
   */
  owners?: string[];
```

- [ ] **Step 4: Attribute**

Add to `src/engine/extractor.ts`:

```ts
/**
 * Which symbols own a line. The enclosing extent when the line is inside one, and otherwise every
 * symbol that references a name the line binds.
 *
 * The second half is what an import needs. Imports are written above every declaration in the file,
 * so no extent encloses them, and attributing them to the first symbol or to all of them are both
 * wrong in the direction that matters: the first invents a dependency, and all of them is the
 * file-level answer this strategy exists to stop giving. A reference inside an extent is the
 * evidence that the symbol needs what the line brought in.
 *
 * Falling back to every symbol when nothing references the binding is deliberate. A side-effect
 * import binds no name at all, and a binding used by nothing is either dead or reached in a way this
 * engine cannot see (a re-export, a type position stripped before it is read). Both are cases where
 * the honest answer is that any export of the file may depend on it, and the closing line of every
 * report already says the flow list is a floor.
 */
function ownersOf(
  symbols: ExtractedSymbol[],
  line: number,
  statement: string,
  source: string,
): string[] {
  const enclosing = symbols.find((symbol) => line >= symbol.startLine && line <= symbol.endLine);
  if (enclosing !== undefined) return [enclosing.id];

  const bound = boundNames(statement);
  if (bound.length > 0) {
    const referencing = symbols.filter((symbol) =>
      bound.some((name) => referencedWithin(source, symbol, name)),
    );
    if (referencing.length > 0) return referencing.map((symbol) => symbol.id);
  }
  return symbols.map((symbol) => symbol.id);
}
```

`boundNames(statement)` is a new exported helper in `src/engine/extractor.ts` that returns the identifiers an import statement binds:

```ts
/**
 * The names an import statement binds. A side-effect import binds none, and its specifier is the
 * whole statement, so reading names out of it would bind whatever the path happens to spell.
 * A renamed binding binds the new name and not the old one, because the new name is what the rest
 * of the file writes.
 */
export function boundNames(statement: string): string[] {
  if (/^[ \t]*import\s*(['"`])[^'"`]*\1[ \t]*;?[ \t]*$/.test(statement)) return [];
  const clause = statement.slice(0, statement.search(/\bfrom\b|$/));
  const names: string[] = [];
  for (const match of clause.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?/g)) {
    const bound = match[2] ?? match[1];
    if (bound !== undefined && !RESERVED_CLAUSE_WORDS.has(bound)) names.push(bound);
  }
  return [...new Set(names)].sort(compareStrings);
}

const RESERVED_CLAUSE_WORDS = new Set(["import", "export", "type", "as", "from", "require", "const"]);
```

`referencedWithin` reads the symbol's own lines and asks whether the name appears there as an identifier:

```ts
function referencedWithin(source: string, symbol: ExtractedSymbol, name: string): boolean {
  const lines = source.split("\n").slice(symbol.startLine - 1, symbol.endLine).join("\n");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_$.])${escaped}(?:[^A-Za-z0-9_$]|$)`).test(lines);
}
```

- [ ] **Step 5: Wire it in**

`extractCaptures` and `extractSymbols` both need `symbols` and the source. Thread them through as parameters and set `owners` only when `symbols.length > 0`:

```ts
        owners: symbols.length === 0 ? undefined : ownersOf(symbols, line, match.groups[0] ?? "", source),
```

For `extractSymbols`, the statement is the matched text and the same call applies; a `pathPattern` rule anchored at line 1 falls through to "every symbol", which is correct: an Inertia page's identity is the whole file.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npx vitest run test/engine/extractor.test.ts && npm run typecheck && npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/engine/extractor.ts src/schema/types.ts test/engine/extractor.test.ts
git commit -m "Give an import to the exports that actually reference it"
```

---

### Task 4: One node per symbol, and an index that can find a file

`build.ts` stops mapping one file to one node. `resolver.ts` gains the file lookup that import resolution needs, because no path is a node id any more.

**Files:**
- Modify: `src/engine/build.ts:112` and `:183-195` (`toNode`)
- Modify: `src/engine/resolver.ts:128-154` (`buildNodeIndex`), `:373-427` (the resolve arms), `:457-477` (`resolveModulePath`), `:493-510` (`resolveAlias`)
- Modify: `src/schema/types.ts` (`NodeIndex`, `GraphNode`)
- Test: `test/engine/build.test.ts`, `test/engine/resolver.test.ts`

**Interfaces:**
- Consumes: `ExtractedFile.symbols` (Task 2), `Capture.owners` (Task 3).
- Produces: `NodeIndex.byFile: Map<string, string[]>` (repo-relative path to the ids that file yields, sorted); `GraphNode.symbol?: string` (the export name, absent on a file-level node); `resolveModuleFile(fromFile, specifier, index, context): string | null` returning the **file path**, with `resolveModulePath` kept as the id-returning wrapper used by `importsNameFrom`.

- [ ] **Step 1: Write the failing tests**

```ts
it("yields one node per exported symbol", () => {
  const graph = buildFixtureRoot("symbol-fixture");
  expect(graph.nodes.map((n) => n.id)).toContain("src/money.ts#formatMoney");
  expect(graph.nodes.map((n) => n.id)).toContain("src/money.ts#parseMoney");
  expect(graph.nodes.map((n) => n.id)).not.toContain("src/money.ts");
});

it("yields the file node for a file that exports nothing", () => {
  const graph = buildFixtureRoot("symbol-fixture");
  expect(graph.nodes.map((n) => n.id)).toContain("src/setup.test.ts");
});

it("points an import at the symbol it names", () => {
  const graph = buildFixtureRoot("symbol-fixture");
  expect(graph.edges).toContainEqual(
    expect.objectContaining({ from: "src/total.ts#total", to: "src/money.ts#formatMoney" }),
  );
});

it("points a side-effect import at every symbol of the file", () => {
  const graph = buildFixtureRoot("symbol-fixture");
  const targets = graph.edges.filter((e) => e.from === "src/boot.ts#start").map((e) => e.to);
  expect(targets).toEqual(expect.arrayContaining(["src/money.ts#formatMoney", "src/money.ts#parseMoney"]));
});
```

Create `fixtures/symbol-fixture/` holding `src/money.ts` (exports `formatMoney` and `parseMoney`), `src/total.ts` (`import { formatMoney } from "./money"` inside `export function total`), `src/boot.ts` (`import "./money"` and `export function start`), and `src/setup.test.ts` (exports nothing). Follow the layout and `empo.config.json` shape of the existing `fixtures/acme-platform`.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run test/engine/build.test.ts -t "symbol"`
Expected: FAIL, the nodes are file ids.

- [ ] **Step 3: Emit one node per symbol**

Replace the `toNode` call in `build.ts:112` with a flat map, and `toNode` itself:

```ts
  const deduped = dedupeNodes(extracted.flatMap(toNodes));
```

```ts
/**
 * The nodes one file yields. A file whose pack found symbols in it yields one per symbol and no node
 * of its own, which is what keeps this change from doubling every name in the index: a `Button.tsx`
 * exporting `Button` carried one node named `Button` before and carries one now. A file whose pack
 * found none yields exactly the node it always did, so nothing about a `fqcn` or `module-path` pack
 * moves.
 *
 * `kind`, `isTest` and `assertsValue` are file-level facts copied onto each node, and honestly so:
 * a kind rule reads a path glob and a content pattern over the whole file, and a test file asserts
 * or does not assert as a file. Naming them per symbol would be inventing a distinction the pack
 * contract does not draw.
 */
function toNodes(file: ExtractedFile): GraphNode[] {
  if (file.symbols.length === 0) return [fileNode(file, file.id, file.name)];
  return file.symbols.map((symbol) => ({
    ...fileNode(file, symbol.id, symbol.name),
    symbol: symbol.name,
    produces: file.produces.filter((ref) => owns(ref.owners, symbol.id)),
    consumes: file.consumes.filter((ref) => owns(ref.owners, symbol.id)),
  }));
}

function owns(owners: string[] | undefined, id: string): boolean {
  return owners === undefined || owners.includes(id);
}
```

`fileNode` is the body of today's `toNode` with `id` and `name` taken as parameters. Add `symbol?: string` to `GraphNode` in `src/schema/types.ts`, documented as the export name and absent on a file-level node.

- [ ] **Step 4: Index by file**

In `buildNodeIndex`, iterate the nodes a file yields rather than the file:

```ts
  for (const file of files) {
    const entries =
      file.symbols.length === 0
        ? [{ id: file.id, name: file.name }]
        : file.symbols.map((symbol) => ({ id: symbol.id, name: symbol.name }));
    byFile.set(file.file, entries.map((entry) => entry.id).sort(compareStrings));
    for (const entry of entries) {
      // the existing body, with file.id replaced by entry.id and file.name by entry.name
    }
  }
```

Add `byFile` to the returned object and to the `NodeIndex` type.

- [ ] **Step 5: Resolve a specifier to a file, then to a symbol**

Split `resolveModulePath` in two. `resolveModuleFile` does today's candidate walk but asks `index.byFile.has(candidate)` instead of `index.ids.has(candidate)`, since under this strategy no path is an id and under the others `byFile` holds every path anyway:

```ts
export function resolveModuleFile(
  fromFile: string,
  specifier: string,
  index: NodeIndex,
  context: ResolveContext,
): string | null {
  // ... unchanged prologue ...
  for (const candidate of candidatePaths(base, context)) {
    if (index.byFile.has(candidate)) return candidate;
  }
  return null;
}
```

Apply the same substitution inside `resolveAlias`. Keep `resolveModulePath` as a wrapper that returns the file's single id where the file yields one, so `importsNameFrom` at `:262-268` keeps working unchanged for `short-name`:

```ts
export function resolveModulePath(
  fromFile: string,
  specifier: string,
  index: NodeIndex,
  context: ResolveContext,
): string | null {
  const file = resolveModuleFile(fromFile, specifier, index, context);
  if (file === null) return null;
  const ids = index.byFile.get(file) ?? [];
  return ids.length === 1 ? (ids[0] ?? null) : file;
}
```

- [ ] **Step 6: Emit one edge per bound name**

In the `module-path` arm of `resolveEdges` (around `:373-386`), replace the single-target push with:

```ts
      const targetFile = resolveModuleFile(file.file, capture.groups[1] ?? "", index, context);
      if (targetFile === null || targetFile === file.file) continue;
      const available = index.byFile.get(targetFile) ?? [];
      // The names the statement binds that the target file actually exports. Where the statement
      // binds nothing this engine can match to an export, the import reaches the whole module: a
      // side-effect import runs the file, and a default or namespace import can reach any of it.
      const bound = boundNames(capture.groups[0] ?? "");
      const named = available.filter((id) => bound.includes(id.slice(id.indexOf("#") + 1)));
      const targets = named.length > 0 ? named : available;
      for (const from of sourcesOf(capture, file)) {
        for (const to of targets) {
          if (to === from) continue;
          edges.push({ from, to, kind: capture.family, symbol: null, file: file.file, line: capture.line });
        }
      }
```

`sourcesOf(capture, file)` returns `capture.owners ?? [file.id]`. Add it beside the arms and use it in all four of them, replacing `from: file.id` at `:375`, `:383`, `:412` and `:425` and turning each single push into a loop over the sources. Keep each arm's existing self-edge guard, comparing against the `from` in hand.

- [ ] **Step 7: Run the tests and verify they pass**

Run: `npm test && npm run typecheck && npm run check`
Expected: PASS. The php and TypeScript fixture snapshots must be **unchanged**, because neither pack declares `symbol` yet. If either moved, the change leaked into a strategy that did not ask for it; fix that before committing.

- [ ] **Step 8: Commit**

```bash
git add src/engine/build.ts src/engine/resolver.ts src/schema/types.ts test/engine fixtures/symbol-fixture
git commit -m "Build one node per exported symbol, and point an import at the name it binds"
```

---

### Task 5: Hazards, coverage and flows under many nodes per file

Three consumers count nodes where they mean files. Each is a one-line fix and each is a wrong number if it is skipped.

**Files:**
- Modify: `src/engine/build.ts:139-165` (`resolveHazards`)
- Modify: `src/engine/coverage.ts:24-26` and `CoverageInfo`
- Test: `test/engine/coverage.test.ts`, `test/engine/hazards.test.ts`

**Interfaces:**
- Consumes: everything from Task 4.
- Produces: `CoverageInfo.testFiles: string[]` beside the existing `testNodes`, sorted, used by every printer that says "N tests".

- [ ] **Step 1: Write the failing test**

```ts
it("counts a test file once however many nodes it yields", () => {
  const info = coverageFor(graphWhereOneTestFileYieldsThreeNodes());
  expect(info.checkout?.testNodes.length).toBe(3);
  expect(info.checkout?.testFiles).toEqual(["src/checkout.test.ts"]);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run test/engine/coverage.test.ts -t "once"`
Expected: FAIL, `testFiles` is undefined.

- [ ] **Step 3: Add the file-level count**

In `src/engine/coverage.ts`, where `testNodes` is assembled, add

```ts
    // The count a reader is owed is files, not nodes: "3 tests reach it" means three test files, and
    // a strategy that yields a node per export would otherwise report one test file as many.
    testFiles: [...new Set(reached.map((id) => fileById.get(id) ?? id))].sort(compareStrings),
```

and thread a `fileById` map in from the graph nodes.

- [ ] **Step 4: Key the deferral by file**

In `resolveHazards` (`build.ts:145`), replace `deferring.add(file.id)` with `deferring.add(file.file)` and change the lookup accordingly, so a deferral declared in a file is read as declared by the file. Add the comment: a commit deferral is a property of the job's file and not of one export of it.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/coverage.ts src/engine/build.ts test/engine
git commit -m "Count a test file once however many nodes it yields"
```

---

### Task 6: `empo query` answers for a file that holds many nodes

`resolveNode` throws "ambiguous" for any path whose file yields more than one node, which under this strategy is nearly every path. A path names a file, and a file's blast radius is the union of its symbols'.

**Files:**
- Modify: `src/commands/query.ts:194-215` (`resolveNode`), `:219-263` (`blastRadius`), `:470-479` (`orphans`), `:843`
- Test: `test/commands/query.test.ts`

**Interfaces:**
- Consumes: `GraphNode.symbol` (Task 4).
- Produces: `resolveNodes(graph, symbol): GraphNode[]` (the plural), and `blastRadius(graph, nodes: GraphNode[])` taking the set. Task 7 calls both.

- [ ] **Step 1: Write the failing test**

```ts
it("answers for every symbol of a path", () => {
  const nodes = resolveNodes(symbolGraph(), "src/money.ts");
  expect(nodes.map((n) => n.id)).toEqual(["src/money.ts#formatMoney", "src/money.ts#parseMoney"]);
});

it("answers for one symbol by its bare export name", () => {
  expect(resolveNodes(symbolGraph(), "formatMoney").map((n) => n.id)).toEqual([
    "src/money.ts#formatMoney",
  ]);
});

it("counts a consumer of two symbols of one file once", () => {
  const radius = blastRadius(symbolGraph(), resolveNodes(symbolGraph(), "src/money.ts"));
  expect(radius.faninDirect).toBe(1);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run test/commands/query.test.ts -t "symbol"`
Expected: FAIL, `resolveNodes` is not exported.

- [ ] **Step 3: Return the set**

Rename `resolveNode` to `resolveNodes`, returning `GraphNode[]`. An exact id match returns one; a path match returns every node of that file **sorted by id**; a name match returns every node carrying the name. The "is ambiguous" error stays, and now fires only where the candidates span more than one file, which is the case a reader really cannot act on:

```ts
  const files = new Set(candidates.map((node) => node.file));
  if (files.size > 1) {
    throw configError(`"${symbol}" is ambiguous`, [
      ...candidates.map((node) => `${node.id}  ${node.file}`),
      "Pass the full id or the full path.",
    ]);
  }
```

- [ ] **Step 4: Union the radius**

Change `blastRadius` to take `GraphNode[]`. Walk from every node in the set, collect into one `Set` of ids, and subtract the set itself before counting, so a symbol importing its sibling is not its own consumer. Dedupe `topConsumers` by node id and flow entries by flow name.

- [ ] **Step 5: Fix the two smaller sites**

`orphans` (`:470-479`) reports one row per unreached node, which under this strategy means one per unused export. That is the right answer and the header must say so: change the heading to name exports where the root's pack declares `symbol`, keyed off whether any node in the graph carries a `symbol` field. At `:843` replace `row.file === row.id` with `row.id === row.file || row.id.startsWith(\`${row.file}#\`)`, so the gods printer still omits a path it has already printed.

- [ ] **Step 6: Run the tests and verify they pass**

Run: `npm test && npm run typecheck && npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/query.ts test/commands/query.test.ts
git commit -m "Answer a path query for every symbol the file holds"
```

---

### Task 7: `empo review` prints per file, not per export

A changed 20-export module must not print twenty blast-radius blocks.

**Files:**
- Modify: `src/commands/review.ts:227-231`, `:1131-1133`, `:1145-1180`, `:1376-1398`, `:1727-1729`
- Test: `test/commands/review.test.ts`

**Interfaces:**
- Consumes: `resolveNodes` and the set-taking `blastRadius` (Task 6).
- Produces: nothing later tasks read.

- [ ] **Step 1: Write the failing test**

```ts
it("prints one blast radius per changed file", () => {
  const output = reviewOutputFor(diffTouching("src/money.ts"), symbolGraph());
  expect(output.match(/fan-in/g)?.length).toBe(1);
});

it("names a test file once in the tests block", () => {
  const output = reviewOutputFor(diffTouching("src/money.ts"), symbolGraph());
  expect(output.match(/src\/money\.test\.ts/g)?.length).toBe(1);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run test/commands/review.test.ts -t "per changed file"`
Expected: FAIL, one block per node.

- [ ] **Step 3: Collapse to one block per file**

At `:227-231`, replace `nodesFor(graph, file.path).map(blastRadius)` with a single `blastRadius(graph, nodesFor(graph, file.path))`, so `radii` becomes one entry per changed file. Update `printChangedFiles` (`:1131`) to print the file path and, where the nodes carry symbols, the export names joined by `", "` and truncated after five with a `+N more`. `printBlastRadius` (`:1145`) then runs once per file with no other change. In `printTests` (`:1376`), iterate `coverage[flow].testFiles` from Task 5 instead of looking each `testNodes` id up.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/review.ts test/commands/review.test.ts
git commit -m "Print one blast radius per changed file, not per export"
```

---

### Task 8: Bump the graph schema to 7

`fanin`, `flows` and `coverage.testNodes` keep their names and change meaning, which is exactly the case the doc comment above `GRAPH_SCHEMA` defines. Without the bump a stale file-level graph is served as though this binary wrote it.

**Files:**
- Modify: `src/engine/graph.ts:65` and the doc comment above it
- Test: `test/engine/graph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("refuses a schema 6 graph", () => {
  expect(() => readGraph(pathToFixture("graph-schema-6.json"))).toThrow(/schema/);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run test/engine/graph.test.ts -t "schema 6"`

- [ ] **Step 3: Bump it**

Set `GRAPH_SCHEMA = 7` and append to the doc comment, in the register of the six entries above it:

```
 * 7 is a meaning change under unchanged names, the case this list exists for. A pack may now
 * identify a node by an exported symbol rather than by a file, so `nodes[].id` can name one export
 * of a file, `fanin` and `flows` are keyed by those ids, and `coverage.testNodes` counts nodes where
 * a reader counting tests means files. Every one of those keys is spelled as it was in 6, and a
 * TypeScript-only repository holds no second pack whose version would signal the drift, so a graph
 * written before this is indistinguishable from one written after it except by this number.
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npm test`
Expected: PASS. Fixture graphs checked into `test/` that carry `"schema": 6` need regenerating; regenerate rather than hand-edit.

- [ ] **Step 5: Commit**

```bash
git add src/engine/graph.ts test/engine/graph.test.ts
git commit -m "Bump the graph schema: the same keys now answer per symbol"
```

---

### Task 9: The TypeScript pack adopts `symbol`

**Files:**
- Modify: `src/packs/typescript/pack.json`
- Modify: `test/packs/versions.json`
- Test: `test/packs/typescript.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("identifies a TypeScript node by its export", () => {
  const graph = buildFixture("acme-platform");
  expect(graph.nodes.some((n) => n.id.includes("#") && n.lang === "typescript")).toBe(true);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run test/packs/typescript.test.ts -t "export"`

- [ ] **Step 3: Adopt the strategy**

In `src/packs/typescript/pack.json`, set

```json
"id": {
  "strategy": "symbol",
  "symbolPattern": "^export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|abstract\\s+class|const|let|var|type|interface|enum)\\s+([A-Za-z_$][A-Za-z0-9_$]*)",
  "indexNames": ["index"]
}
```

and bump `"version"` to `"2.0.0"`: this changes what every id in a TypeScript graph means, which is the major-version case the pack contract defines.

- [ ] **Step 4: Update the pinned hash**

Run `npx vitest run test/packs/versions.test.ts` to get the new sha256 from the failure, and write the new version and hash into `test/packs/versions.json`.

- [ ] **Step 5: Refresh the fixture snapshots**

Run `npx vitest run test/packs/typescript.test.ts -u`, then **read the whole diff**. Every changed line is a claim about the acme fixture; confirm each one is the intended per-export answer and not a lost edge. A vendor import that used to resolve and now does not is a regression, not a snapshot to accept.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck && npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/packs/typescript/pack.json test/packs
git commit -m "Identify a TypeScript node by the symbol it exports"
```

---

### Task 10: Docs

Every doc claim about this strategy currently says it is unbuilt. Each of those sentences is now false.

**Files:**
- Modify: `docs/04-language-packs.md:190-210` (the strategy list and the refusal paragraph), and the `resolve` table's surrounding prose if it names the count of built strategies
- Modify: `docs/05-graph-model.md` (what a node is)
- Modify: `docs/06-cli.md` (the `empo query` and `empo review` sections, where a node is described as a file)
- Modify: `docs/14-implementation-notes.md:69` and the "deliberately did not build" list

- [ ] **Step 1: Rewrite the strategy list**

Replace "only two of the three are built" and the refusal paragraph with what is now true: all three are built; `symbol` needs a `symbolPattern`; the extent is a line partition and a declaration not written at column 0 does not open one; a file whose pattern matches nothing yields the file-level node instead.

- [ ] **Step 2: State the ceiling where a reader will meet it**

In `docs/05-graph-model.md`, say plainly that under `symbol` a test file's reach is counted in files and its nodes in exports, that an import binding nothing this engine can match reaches the whole module, and that text between two exports belongs to the export above it.

- [ ] **Step 3: Remove the stale unbuilt claims**

In `docs/14-implementation-notes.md`, drop `symbol` from the "described but deliberately not built" list, leaving `--root` there, and fix line 69.

- [ ] **Step 4: Check no doc still calls it unbuilt**

Run: `grep -rniE "symbol.*(not implemented|unbuilt|not built)" docs src`
Expected: no hits.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "Say that the symbol strategy is built, and what it cannot see"
```

---

## Self-Review

**Spec coverage.** The five one-to-one assumptions named in the sizing pass each have a task: `resolver.ts:474/506` (Task 4 Step 5), `resolver.ts:375/383/412/425` (Task 4 Step 6), `build.ts:112/183` (Task 4 Step 3), `query.ts:198` (Task 6), `coverage.ts:24` (Task 5). The missing extent primitive is Task 2, the schema bump is Task 8, the pack adoption is Task 9, the docs are Task 10. The bridger blow-up named in the sizing pass is handled upstream by `SymbolRef.owners` (Task 3) filtered in `toNodes` (Task 4 Step 3), so no `bridger.ts` change is needed; Task 4 Step 7 is where a blow-up would show as a moved snapshot.

**Type consistency.** `ExtractedSymbol` is defined in Task 2 and read in Tasks 3 and 4. `owners` is added in Task 3 and read in Task 4 by `sourcesOf` and `owns`. `resolveModuleFile` is introduced in Task 4 and used only there. `resolveNodes` and the set-taking `blastRadius` are introduced in Task 6 and consumed in Task 7. `testFiles` is introduced in Task 5 and consumed in Task 7 Step 3.

**Known gap, stated rather than hidden.** `health.ts` needs no change (its counts were already written per file), and `diff.ts`, `citations.ts`, `check.ts`, `verify.ts` and `spines.ts` resolve no node at all. Narrowing a changed *line range* to the symbols it touches is the real payoff of symbol ids and is **not** in this plan; it belongs in a follow-up once the ids exist.
