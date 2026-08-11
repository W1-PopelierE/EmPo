# 14. Implementation notes (scaffolding)

Concrete build decisions and starting scaffolding for the `empo` package. This turns the
design docs into a repository a first coding session can populate without re-deciding stack
questions. Everything here is a default, chosen for a small dependency surface and a fast,
deterministic CLI. Deviate with a reason, recorded in this doc.

## Stack decisions

| Concern | Choice | Why |
|---------|--------|-----|
| Runtime | Node 22.12+, ESM (`"type": "module"`) | Matches `npx` distribution and the agent host runtime. LTS. The floor is what `commander` and `execa` demand, not a preference. It said `20+` once and was wrong. |
| Language | TypeScript 7, strict | The CLI computes; types keep the graph/pack contracts honest. Typechecking only, `tsc --noEmit`, because tsup emits. |
| CLI parser | `commander` 15 | Small, mature, no ceremony. Subcommands map to `src/commands/*`. |
| Bundler | `tsup` 8 (esbuild) | One command to a single shebang'd `dist/empo.js`. Fast. |
| Test runner | `vitest` 4 | Fast, ESM-native, snapshot support for pack fixtures. |
| Lint + format | `biome` 2 | One tool, fast, no eslint+prettier sprawl. |
| Config validation | `zod` 4 | Single source of truth: the runtime validator generates the editor JSON Schema, and zod 4 does that conversion itself with `z.toJSONSchema`. |
| File walking | `tinyglobby` | Tiny glob matcher for roots and `ignore`. |
| Glob matching | `picomatch` | Answers "does this path match this glob" for `kindRules.pathGlob`, in `engine/extractor.ts`. `tinyglobby` walks the tree, `picomatch` matches a path already in hand. |
| Subprocess | `execa` | git and adapter CLIs (`gh`, `glab`) are shelled out, not re-implemented. Used by `engine/git.ts`, the only module that shells out to git. |
| Git / worktrees | shell out via `execa` | The review needs `git worktree`; a JS git lib buys nothing here. |

Three deviations from what this table first pinned, recorded here as the rule above requires:

- **zod moved to v4.** It converts a schema to JSON Schema natively (`z.toJSONSchema`, used in
  `src/schema/config.schema.ts`), so the `zod-to-json-schema` devDependency is gone and the editor
  schema still has exactly one source.
- **typescript moved to v7 and emits nothing.** `tsc --noEmit` is a typecheck step; tsup and
  esbuild produce `dist/empo.js`. Two tools, one job each.
- **picomatch became a direct dependency.** `kindRules.pathGlob` matches a path the scanner has
  already read, which is a different job from walking a tree, and `tinyglobby` does not expose a
  standalone matcher.

`execa` landed with `engine/git.ts`, which is the only module that calls it. Every call there is
best-effort: a repository that is not a git checkout still indexes, it just cannot report staleness.

No AST parser is a dependency. Extraction is regex-over-source per pack ([04-language-packs](04-language-packs.md)),
which is the deliberate portability/blind-spot tradeoff. A pack that genuinely needs AST ships its
own parser inside its optional `module`, it does not pull one into the engine.

### tree-sitter, evaluated and declined

This was reopened and measured rather than argued, so it does not need reopening again without new
facts. A working tree-sitter driver was built against the php fixtures and reproduced `expected.json`
exactly, so on clean code the two approaches are equivalent. What decided it:

- **Speed.** On 4,900 files and 14.3 MB of PHP: regex 157 ms, tree-sitter 4,518 ms, 28.8x slower.
  Even a native binding would be about 13x slower.
- **Distribution.** The native binding compiles at install (`node-gyp`), which an `npx` CLI cannot
  ask of anyone, and `tree-sitter-php` and `tree-sitter-typescript` declare disjoint peer ranges on
  the runtime, so the two languages v1 promises cannot be installed together. Only the WASM path is
  viable, at about 1 MB of vendored grammar per language.
- **It loses things regex has.** A quoted class name (`'Acme\\Models\\Payment'`) fragments into
  separate string nodes in the PHP grammar, so the `string` edge family breaks, and a Blade template
  parses as one opaque `text` node with zero captures and `hasError: false`, so the `template` family
  stops working entirely. That last one has since stopped being hypothetical: the php pack fills
  `template` from Blade component tags, and those are exactly the edges the `text` node would swallow
  in silence, with `hasError: false` reporting a clean parse of nothing.
- **The level-2 bridge gains nothing.** Joining a produced route to a consumed one is string
  comparison across two parse trees, and that is where the interesting failures live.
- **It narrows language reach rather than widening it.** tree-sitter's long list is host-language
  bindings, of which EmPo would use one. The grammar list is about 24, and a regex pack needs no
  grammar to exist at all.

What tree-sitter was genuinely right about was comments, and that defect was real: rules were reading
commented-out routes and class names inside block comments. That is fixed in `engine/mask.ts` at no
runtime or distribution cost. The one open argument in tree-sitter's favour is the unimplemented
`symbol` node-id strategy (per-export granularity for TypeScript), where it extracts 7 of 7 export
forms against a regex's 4 of 7. If that strategy is ever built, revisit this decision then, and
revisit it inside a pack's `module` escape hatch rather than in the engine.

## Repository layout (target state)

```text
empo  (this repo)
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
  biome.json
  src/
    empo.ts                  # bin entry: runs the program, catches EmpoError, sets exit codes
    program.ts               # wires commander to commands/, so a spec can parse argv without running one
    errors.ts                # typed EmpoError + gateFailure/configError/environmentError (06-cli codes)
    commands/
      init.ts                # detect langs, scaffold .empo/, wire host, brief and gate the map
      index.ts               # build graph.json  (name it index-cmd internally; `index` is loaded)
      query.ts               # blast radius answer
      verify.ts              # spine citation drift
      check.ts               # commit gate
      review.ts              # orchestrate the review discipline, and name the spines touched
      update.ts              # regenerate host instruction files
      doctor.ts              # health checks, prose or --json, computing nothing of its own
      hook.ts                # the three host hooks: a payload on stdin, JSON or silence on stdout
      pack.ts                # `empo pack test <name>`
    engine/
      config.ts              # load + zod-validate config.json
      pack-loader.ts         # load a pack (json rules + optional module), validate
      scanner.ts             # walk roots, apply ignore, yield {root, file, source}
      mask.ts                # blank comments before any rule runs, keeping offsets and lines
      order.ts               # the one string comparator every sort in the engine uses
      extractor.ts           # apply one pack's rules to one file -> raw captures
      resolver.ts            # turn captures into node ids per `resolve` strategy
      names.ts               # tally what the name strategies resolved and refused, and print it
      build.ts               # one pack over one root: scan, extract, resolve, dedupe, sort
      bridger.ts             # match produce/consume across roots -> bridge edges
      flows.ts               # assign non-test nodes to flows by longest path-prefix, across roots
      coverage.ts            # cross-ref test nodes -> per-flow coverage (blind detection)
      git.ts                 # sha, refs, worktrees, and the one run() every subprocess goes through
      diff.ts                # unified-diff parser: which files changed and which line numbers
      citations.ts           # resolve a file:line:anchor against real source, verified/moved/absent
      spines.ts              # load every spine and enumerate the citations it states
      guard.ts               # does this diff touch a spine's guarded files, and did a test assert
      detect.ts              # init step 1: roots and languages from each pack's `match` block
      scaffold.ts            # init step 2: the generated config, and never an overwrite
      proposal.ts            # init step 5: gate an agent's flows and spines, write the survivors
      graph.ts               # assemble Graph, compute fanin, serialize deterministically
      health.ts              # the facts doctor renders and session-start reads, adapters included
      hazards.ts             # transaction extents and the dispatches inside them, from pack markers
    packs/
      php/
        pack.json            # the declarative rules
        hard-cases.ts        # UNBUILT: the optional refine() escape hatch, if a pack needs one
        fixtures/            # synthetic source tree + expected graph snapshot
      typescript/
        pack.json
        fixtures/
    adapters/
      forge/
        types.ts             # the ForgeAdapter interface
        create.ts            # config -> adapter, and where graceful degradation lives
        local.ts  github.ts  mcp.ts
      host-input.ts          # reads an agent-supplied payload and checks it against real git
      tracker/
        types.ts             # the TrackerAdapter interface
        create.ts            # config -> adapter, same degradation rule
        key.ts               # ticket-key extraction, the universal half of the contract
        criteria.ts          # acceptance criteria out of a ticket body, shared by every tracker
        none.ts  github-issues.ts  mcp.ts
    discipline/
      review.md              # the shipped, universal review workflow (from doc 07)
      map.md                 # the shipped map workflow empo init prints (from docs 06 and 08)
      findings.ts            # the verification gate: citations resolved, hedges dropped, survivors
      phrasing.ts            # the forbidden-phrasing lint, over a finding's own text and nothing else
      load.ts                # find a discipline file under src/ or beside dist/, as pack-loader does
      prompts/               # UNBUILT: verification prompt templates, ticket-fit template
    host/
      agents.ts              # render the managed AGENTS.md block, and merge it without losing bytes
      claude.ts              # generate the .claude/ skills and hook entries (not a plugin: doc 10)
    schema/
      config.schema.ts       # zod schema for config.json, re-exported as JSON Schema
      findings.schema.ts     # zod schema for a findings file, untrusted input like a pack.json
      flows.schema.ts        # zod schema for flows.json
      spine.schema.ts        # zod schema for spines/*.json, strict, an unknown key is refused
      proposal.schema.ts     # zod schema for a proposal file, importing the two schemas above
      pack.schema.ts         # zod schema for a pack.json, including that every regex compiles
      types.ts               # shared Graph/Node/Edge/Pack TS types (the contracts)
  fixtures/
    acme-platform/           # the fictional monorepo from examples/, for integration tests
  test/
    engine/  packs/  adapters/  discipline/  schema/  commands/  host/   # vitest specs mirror src/
```

The heading says target state and means it, so two entries above are marked `UNBUILT` rather than
quietly left in: `discipline/prompts/`, and the `hard-cases.ts` no pack has needed yet. Everything
else in the tree is on disk. A layout that mixes what exists with what is planned and marks neither
is how a reader ends up looking for a file that was never written, so the marker is the point rather
than a footnote. `engine/hazards.ts` carried the same marker until the hazard axis landed
([04-language-packs](04-language-packs.md) section 7, [06-cli](06-cli.md)); it is on disk now, and
the marker came off in the same session the file appeared, which is the only way this list stays
worth reading.

Note the naming collision: the command is `empo index`, but `index.ts` is a loaded module name in
JS. Keep the command file `commands/index.ts` but export a named `indexCommand`, and never rely on
default index resolution for it.

Two schema files, not one, because a `pack.json` is untrusted input in the same way a `config.json`
is. `schema/config.schema.ts` is the file that exists; earlier notes that shortened it to
`schema/config.ts` meant this one. `engine/config.ts` is a third thing again, the loader that finds
the config on disk and reports its errors.

`engine/build.ts` is the seam between the per-file pipeline and the graph. It runs one pack over
one root and returns nodes and edges already deduplicated and sorted, so `empo pack test` and
`graph.ts` (once per root) share one set of ordering rules rather than each inventing their own.

`diff.ts` and `citations.ts` are engine modules and not review-only ones, because each has a second
caller waiting. A diff comes from git, never from a forge's API, and `empo check` reads the staged
diff through the same parser, so putting it inside a forge adapter would have made the commit gate
depend on a pull-request host it does not have. A citation anchor resolves the same three ways for a
finding and for a spine, so `empo verify` resolves spine anchors through `checkCitation` and a
citation in a review and a citation in a spine rot in exactly the same, visible way
([08-spines](08-spines.md)). `empo review` is now the place where both happen inside one command:
the brief resolves a touched spine's coordinates against the code under review, and `--findings`
resolves the agent's coordinates against that same recorded read root minutes later. One checker, so
the moved anchor a reviewer was shown and the moved anchor the gate corrected are one verdict rather
than two implementations that happen to agree today. What is genuinely review-only, the gate and the
phrasing lint, sits in `discipline/` instead.

`engine/guard.ts` owns one predicate three commands ask, `guardsPath`: `empo check` computes a
verdict's `touched` with it, the pre-edit hook warns before an edit lands on a guarded file with it,
and `empo review` names the spines a change is on with it. It was two hand-written copies of the
same one-line `.some(...)` until the third caller arrived. Copies of a rule like this never diverge
on the day they are written; they diverge on the day one of them learns something, and the thing
this rule had to learn was `dot: true`. A second copy that had not learned it is how a brief comes
to name a spine the gate will not fire on, or stays silent about one it will, and a reviewer has no
way to see that from the output.

That prediction came true a second time and the shared predicate is what made the repair one edit.
The rule had to learn that a **rename carries two paths**, and matching the new one alone let
`git mv` walk a guarded file out from under its own guard. The lesson for the next caller is where
the fix landed rather than
that it was needed: `guardsPath` still takes a path, because the pre-edit hook has only a path, and
the two-spelling question is a second function beside it, `guardedTouches`, which takes a
`ChangedFile`. Everything holding a diff asks that one, so the gate and the brief cannot answer
differently about a moved file either.

## `package.json`

```jsonc
{
  "name": "empo",
  "version": "0.1.0",
  "description": "Language-agnostic impact and review toolkit that keeps an AI agent honest about a codebase",
  "type": "module",
  "private": true,
  "license": "MIT",
  "bin": { "empo": "./dist/empo.js" },
  "engines": { "node": ">=22.12.0" },
  "files": ["dist", "src/packs/*/pack.json", "src/discipline"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "biome check .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^15.0.0",
    "execa": "^10.0.0",
    "picomatch": "^4.0.5",
    "tinyglobby": "^0.2.17",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.5",
    "@types/node": "^22.0.0",
    "@types/picomatch": "^4.0.3",
    "tsup": "^8.5.1",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

This block and the two below it are copies of files that live at the repository root, and the file
is always the authority: open it there before acting on anything a block here says, because a copy
in prose drifts and the argument around it is what this page is for.

`files` ships the pack JSON and the discipline markdown alongside the bundled `dist`, because the
engine reads them at runtime. A pack's optional `hard-cases.ts` would be bundled into `dist` by
tsup, so it will need no entry here when the first pack grows one.

`version` is written by a machine and never by hand. `.github/workflows/ci.yml` bumps it on every
merge to main, and [10-distribution](10-distribution.md) has the rules, the labels that override the
default patch, and the two costs of doing it that way. It is the one line in this block that a copy
in prose is guaranteed to be wrong about, so read the file.

`engines` says `>=22.12.0`, and that number is `commander@15`'s, not a preference: `execa@10` needs
22 and commander needs 22.12.0, so the floor is the highest thing the dependency tree demands. It
said `>=20` while the package provably did not start there, and Node 20 reached end of life in April
2026, so the fix was to say the true number rather than to work around it. The CI
matrix is 22 and 24, `tsup`'s `target` is `node22` to match, and `test/engines.test.ts` fails if a
dependency bump moves the real floor above the declared one again.

MIT, declared in `package.json` and in a `LICENSE` at the repository root. A tool that asks to be
run inside other people's repositories should carry the least surprising license there is.

## `tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "*.config.ts"],
  "exclude": ["src/packs/*/fixtures"]
}
```

`noEmit` because tsup does the emitting, so `tsc` is a typechecker and nothing else. `include`
covers `test` and the config files too, so `npm run typecheck` also checks the specs rather than
letting them rot around a changed contract. The `exclude` is the other half of that decision and is
argued for further down: a pack's fixtures are data to be regex-matched, not source to be
typechecked.

`noUncheckedIndexedAccess` is on deliberately: the engine indexes into maps of nodes by id
constantly, and the graph is only as trustworthy as its lookups.

## `tsup.config.ts`

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { empo: "src/empo.ts" },
  format: ["esm"],
  target: "node22",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },   // makes dist/empo.js directly executable
});
```

## The contracts (`src/schema/types.ts`)

These interfaces are the spine of the codebase. Pin them first; everything else consumes them. They
are the TypeScript form of [05-graph-model](05-graph-model.md) and [04-language-packs](04-language-packs.md).

```ts
export type EdgeKind = "import" | "fqcn" | "string" | "template" | "hook" | "bridge";
export type NodeStrategy = "fqcn" | "module-path" | "symbol";

/** How a captured string becomes a target node id. Engine-side, not pack-extensible. */
export type ResolveStrategy =
  | "fqcn" | "fqcn-string" | "module-path" | "view" | "observer" | "short-name";

export interface SymbolRef {
  symbol: string;        // "http-route", "event", ...
  key: string;           // normalized key, e.g. "POST v1/orders"
  line: number;
}

export interface GraphNode {
  id: string;            // stable per pack.node.id.strategy
  file: string;          // repo-relative
  root: string;
  lang: string;
  kind: string;          // from pack kindRules
  name: string;
  produces: SymbolRef[];
  consumes: SymbolRef[];
  isTest: boolean;
  assertsValue: boolean;   // a test using one of the pack's assertionTerms. False on a non-test.
}

/** One end-user journey from flows.json. `paths` are repo-relative path prefixes. */
export interface FlowDefinition {
  label?: string;
  paths: string[];
}

export type FlowDefinitions = Record<string, FlowDefinition>;

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  symbol: string | null;                 // set only for bridge edges
  evidence: { file: string; line: number };
}

export interface CoverageInfo {
  flow: string;
  testNodes: string[];
  reaches: boolean;
  assertsValue: boolean;
  blind: boolean;        // reaches && !assertsValue
}

/** One queued job dispatched from inside a database transaction without waiting for the commit. */
export interface Hazard {
  file: string;          // repo-relative, the dispatch site
  line: number;          // the dispatch
  job: string;           // the job as written at the dispatch site
  target: string | null; // resolved node id, null when no node in this root carries that name
  transactionLine: number;                  // the line that opened the enclosing transaction
}

/** Why a name did or did not become a node id. Five ways to fail, because they want five reactions. */
export type NameVerdict =
  | "resolved" | "unknown" | "ambiguous" | "wrong-kind" | "local" | "vendor";

/** One name more than one node carries, and what the refusal cost. `nodes` is never below 2. */
export interface AmbiguousName { name: string; nodes: number; references: number }

/** What one family's name-resolving rules did with every name they read, counted per reference. */
export interface NameResolution {
  family: Exclude<EdgeKind, "bridge">;   // never "bridge": a bridge resolves keys, not names
  resolved: number;
  unknown: number;       // the name is in no node: a vendor component, a Blade built-in
  ambiguous: number;     // the name is in several nodes, so no edge is emitted to any of them
  wrongKind: number;     // one node carries it, of a kind the rule's `targetKinds` does not list
  local: number;         // the file that wrote the reference declares the name itself
  vendor: number;        // that file imports the name from a package this repository depends on
  ambiguousNames: AmbiguousName[];       // so the count names something a reader can go and fix
}

export interface Graph {
  schema: number;                        // the format read off disk, so a graph older than the code is expressible
  builtAgainst: string;                  // git sha
  builtAtCommitSubject: string;
  roots: { path: string; lang: string }[];
  packs: Record<string, string>;         // name -> version
  stats: { files: number; nodes: number; edges: number; bridgedEdges: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  flows: Record<string, string[]>;       // flow key -> node ids
  fanin: Record<string, number>;
  coverage: Record<string, CoverageInfo>;
  hazards: Hazard[];                     // empty when no pack declares a hazards block
  hazardsScanned: string[];              // which langs' packs looked, as of this build, sorted
  names: NameResolution[];               // empty when no rule in these packs resolves by name
}

/** One extraction rule in an `edges.<family>` list. Capture group 1 is the target. */
export interface ExtractRule {
  pattern: string;
  resolve: ResolveStrategy;
  normalize?: Normalizer[];   // applied to every group before the strategy reads it
  pathGlob?: string;          // where the rule may run, root-relative; absent means everywhere
  targetKinds?: string[];     // kinds a name-resolving strategy may land on
  maskStrings?: boolean;      // read the view with string contents blanked, so prose is not code
}

/** Per-part normalizers applied before a symbol key is assembled. */
export type SymbolNormalizer = "upper" | "lower" | "strip-leading-slash";

export interface SymbolRule {
  symbol: string;        // "http-route", "event", ...
  pattern?: string;      // a regex over the source. Exactly one of pattern / pathPattern is set.
  pathPattern?: string;  // a regex over the path, for a symbol whose identity is where it sits
  map: Record<string, number>;              // part name -> capture group
  key?: string;          // template over parts, e.g. "{method} {path}". Default: parts joined by space.
  normalize?: Record<string, SymbolNormalizer[]>;
}

export interface PackNodeId {
  strategy: NodeStrategy;
  namespacePattern?: string;
  namePattern?: string;
  fallback?: "path";     // what to do when the strategy cannot produce an id
  indexNames?: string[]; // module-path: basenames that stand for their own directory ("index")
}

/** How this language writes comments and string literals, so `engine/mask.ts` can blank comments. */
export interface CommentSyntax {
  line?: string[];
  block?: [string, string][];
  stringQuotes?: string[];
  stringEscape?: string;
  multilineQuotes?: string[];  // the quotes whose literal may hold a raw newline. Absent means all.
}

/** Who reaches a node of this kind, when it is not an edge the pack's own rules can see. */
export type KindResolver = "framework";

export interface PackKindRule {
  kind: string;
  pathGlob?: string;
  contentPattern?: string;
  maskStrings?: boolean;       // contentPattern reads the string-blanked view. Needs contentPattern.
  resolvedBy?: KindResolver;   // the framework resolves it by name, so fan-in zero proves nothing
  arrivedBy?: KindArrival;     // somebody outside the code arrives here, so a journey starts
}

/** How a transaction's extent is found once its opening pattern matched. */
export type HazardExtent = "balanced" | "span";

export interface HazardTransactionRule {
  pattern: string;
  extent: HazardExtent;
  open?: string;         // balanced only: the delimiter pair to count
  close?: string;
  endPattern?: string;   // span only: what closes the transaction
}

export interface HazardDispatchRule { pattern: string; job: number }  // job: 1-based capture group

/** The optional hazard axis. Absent means this pack makes no claim, which is not "found none". */
export interface PackHazards {
  transactions: HazardTransactionRule[];
  dispatches: HazardDispatchRule[];
  deferAtSite: string[];         // matched at the dispatch site: this one dispatch waits
  deferAtDeclaration: string[];  // matched in the job's own declaration: every dispatch waits
}

export interface Pack {
  name: string;
  version: string;
  match: { extensions: string[]; manifest?: string[] };
  node: {
    id: PackNodeId;
    kindRules: PackKindRule[];
  };
  comments?: CommentSyntax;
  commentsByExtension?: Record<string, CommentSyntax>;   // keyed ".vue": an SFC template is html
  edges: Partial<Record<Exclude<EdgeKind, "bridge">, ExtractRule[]>>;
  produces: SymbolRule[];
  consumes: SymbolRule[];
  tests: {
    paths: string[];
    importsRule: string;
    assertionTerms: string[];
    assertionExcludes: string[];   // removed from the source before any assertionTerm is matched
  };
  declares?: string[];     // optional: patterns whose first group is a name this file declares
                           // itself. Read by the two name-resolving strategies and by nothing else;
                           // a pack that declares none resolves every name as it always did.
  packages?: PackPackageSource;  // optional: where this language's manifest names a package and its
                                 // dependencies, so a name imported from a package can be refused.
                                 // Read by the same two strategies; a pack that declares none gets
                                 // an empty set and resolves every name as it always did.
  views?: PackViews;       // optional: { roots, extensions }, where this framework keeps its
                           // templates. Read by the "view" resolve strategy and by nothing else,
                           // and required by a pack that names it (schema/pack.schema.ts).
  hazards?: PackHazards;   // optional: a pack that declares none makes no hazard claim at all
  aliasSources?: PackAliasSource[];  // optional: where this toolchain writes import aliases.
                                     // Read by empo init to seed config roots[].aliases, and by
                                     // nothing else: empo index opens no toolchain config.
  module?: string;       // path to optional refine() escape hatch
}

export interface PackModule {
  refine(node: GraphNode, edges: GraphEdge[], source: string):
    { node: GraphNode; edges: GraphEdge[] };
}
```

Four additions to the first sketch, each one forced by building against the fixtures:

- **`ResolveStrategy` is a union, not `resolve: string`.** The resolver has one case per strategy,
  so strategies are engine-side and a pack cannot invent one. As a union, an unknown strategy is
  rejected by `pack.schema.ts` when the pack loads instead of surfacing as a missing edge later.
- **`PackNodeId.fallback: "path"`.** A route file or a script has no class, and still has to be a
  node, otherwise everything declared in `routes/api.php` is invisible to the graph. A pack that
  wants such files skipped leaves `fallback` unset.
- **`SymbolRule.key` and `SymbolRule.normalize`.** `map` says which capture group is which part, not
  how to assemble them into a key. `key` is a template over the parts (`"{method} {path}"`) and
  `normalize` is a per-part list (`upper`, `lower`, `strip-leading-slash`), which is what lets a
  route produced by one pack and consumed by another normalize to the same string deterministically.
- **`GraphNode.assertsValue`.** Coverage needs to know, per test node, whether that test asserts on a
  value, and only the pack knows what counts as one. Computing it at extraction and carrying it on
  the node keeps `engine/coverage.ts` a pure aggregation over graph pieces instead of a second reader
  of source files.

A fifth, forced the same way by the typescript pack:

- **`PackNodeId.indexNames`.** `module-path` has to turn `../components` into `components/index.ts`,
  and the only alternative to the pack declaring that basename was the engine assuming it. "index" is
  Node's answer and `__init__` is Python's, so the assumption would have been a language sitting
  inside the engine, which is the one thing [04-language-packs](04-language-packs.md) exists to
  prevent.

A sixth, forced by the transaction-hazard axis rather than by a pack:

- **`PackHazards` on the pack and `Hazard[]` on the graph, optional on one side and mandatory on the
  other.** The asymmetry is the design and not an oversight. A pack may leave `hazards` out, which is
  how it says this language has no such hazard to look for; the graph always carries the array, which
  is how `empo query --hazards` can say "looked, found none" instead of falling silent. Two absences
  that mean different things must not be spelled the same way, which is the rule
  [05-graph-model](05-graph-model.md) already applies to a flow that matches no node. `hazardsScanned`
  is the third piece of the same argument and the one that is easy to leave out: which packs looked
  is a fact about the build, so a graph that does not record it can only be asked about the packs as
  they are now, and a pack that grew its rules after the build would then report "looked" over files
  nothing scanned.
  `Hazard.target` is nullable for the matching reason: a job named through a variable or built by a
  factory resolves to no node, and the dispatch is still worth reporting, because what makes it a
  hazard is the enclosure rather than the callee. It follows `GraphEdge.symbol`, a present key with a
  null value rather than an absent one.

## Determinism rules (non-negotiable)

`empo index` must produce byte-identical output for identical input, so a graph is diffable and
"did the graph change" is answerable ([05-graph-model](05-graph-model.md)):

- Sort `nodes` by `id`, `edges` by `(from, to, kind, evidence.line)`, `hazards` by
  `(file, line, job, target)` before serializing.
- No timestamps in the output except `builtAgainst`, which is a content-derived git sha.
- Stable JSON key order; two-space indent; trailing newline.
- Any map iterated during assembly is sorted first. Do not rely on insertion order.
- **Every string sort compares code units, never `localeCompare`.** One shared `compareStrings` in
  `engine/order.ts` is the only comparator the engine uses. `localeCompare` orders `alpha` before
  `Beta`, it orders Czech `hodina` before `chleba` while English does the reverse, and a Node built
  with small-icu disagrees with one built with full-icu. Any of those turns a graph that should be
  byte-identical between two developers into a diff. This was a real defect in `extractor.ts`, found
  by sorting keys that differ in case.

Two more rules decided while building, both applied in `engine/build.ts` so every caller inherits
them:

- **One edge per `(from, to, kind)`, earliest evidence wins.** A second reference between the same
  pair is the same coupling, and counting it twice would inflate fan-in, which is the blast-radius
  headline number. Earliest means lowest `(evidence.file, evidence.line)`, so which duplicate
  survives does not depend on rule order. The kind is in that key on purpose, so a pair coupled two
  ways keeps both pieces of evidence, and that no longer costs a fan-in either:
  `computeFanin` counts the nodes that reference a node rather than the edges that do
  ([05-graph-model](05-graph-model.md)), which is what a rendered-and-imported React component forced.
- **An edge whose target is not a node in the graph is dropped.** A vendor import is not a coupling
  this repository can break, so it is noise in every count that follows. A self-reference is dropped
  for the same reason: a file naming itself couples nothing.

Two defects found while building, each fixed where it belongs rather than where it surfaced:

- **Duplicate node ids.** A node id is an identity, so two files claiming one is a defect in the
  indexed repository. It is not a reason to refuse to build: a stub directory or a copied class does
  this. The file that sorts first wins, and the collision is reported by the caller (`empo index`
  prints it) rather than thrown. Edges found in the losing file keep their own evidence, which still
  points at real source, and merge into the surviving id. Applied by `dedupeNodes` in
  `engine/build.ts`, per root and again across roots, so one root and a whole monorepo behave the
  same.
- **A `produces`/`consumes` `map` naming a capture group its pattern does not have.** It used to
  yield a silently empty key, and an empty key matches nothing forever. `pack.schema.ts` now counts a
  pattern's capture groups and rejects the pack at load time, where the message can name the pack,
  rather than letting it surface as a missing bridge edge someone has to go hunting for. The same
  check rejects a `key` template or a `normalize` entry naming a part that is not in `map`, and an
  edge rule with fewer capture groups than its `resolve` strategy reads (`observer` reads two,
  everything else reads one).

`test/engine/determinism.test.ts` is the guardrail. It builds the acme fixture twice, asserts the
two serializations are identical bytes, and then asserts each rule above separately, so a failure
names which rule broke rather than only that the bytes moved.

## The first vertical slice

Do not build the commands left to right. Build one thin slice end to end so the pack contract is
proven before anything depends on it. Order within phase 1:

1. **Done: `schema/types.ts` + `schema/config.schema.ts`** (zod) and **`empo doctor`** that only
   validates `config.json`. Smallest useful command, no engine. Proves the config shape. What
   landed: the contracts, the config schema and its generated JSON Schema (`configJsonSchema()`),
   `engine/config.ts` to find and load the file from either supported location, `errors.ts` for the
   exit codes, and a `doctor` that reports roots, packs, bridges, uninstalled packs, bridge sides
   naming no configured root, and top-level directories under no root. Staleness waits for the
   graph.
2. **Done: the php pack pipeline against fixtures**: `pack-loader` + `scanner` + `extractor` +
   `resolver` + `build`, driven by `packs/php/pack.json`, verified by `empo pack test php` diffing
   `packs/php/fixtures`. This is the slice that proves the whole extraction contract. The fixture
   corpus came first (a controller, a model, an observer, a provider, a calculator, a route file
   and a feature test, with known imports, an observer registration and two routes), then the
   snapshot, then the pipeline until it matched. `schema/pack.schema.ts` validates the pack itself,
   every declared regex included.
3. **Done: `graph.ts` + `empo index`**: assemble the graph from the extracted pieces, deterministic
   serialization, the determinism test. `build.ts` already returned sorted, deduplicated pieces per
   root, so this step was assembly across roots plus `fanin`, `stats` and the git fields. What
   landed: `engine/graph.ts`, the only module that constructs, reads or writes the shape in
   [05-graph-model](05-graph-model.md), which assembles every root into one graph, computes `fanin`
   and `stats`, fills the git fields through `engine/git.ts`, serializes deterministically, and reads
   `graph.json` back with the staleness line every reading command prints; `commands/index.ts`
   exporting `indexCommand`, which writes `.empo/generated/graph.json` and `packs.lock.json`, and
   whose `--check` compares bytes and exits 1 when the graph on disk is not what a rebuild would
   produce; `engine/flows.ts` and `engine/coverage.ts` for the derived indexes; `commands/query.ts`;
   and `fixtures/acme-platform`, the integration fixture whole commands run against.
4. **Done: `flows.ts` + `coverage.ts` + `empo query`**: derived indexes and the blast-radius answer,
   including blind-flow detection. First genuinely valuable output. What landed: `engine/flows.ts`,
   assigning nodes to flows by longest path-prefix across roots, with `schema/flows.schema.ts`
   validating `flows.json`; `engine/coverage.ts`, walking edges out of every test node to decide
   `reaches`, `assertsValue` and `blind` per flow; and `commands/query.ts`, which answers one
   symbol's blast radius and carries `--blind`, `--gods`, `--orphans` and `--json`.
5. **Done: the typescript pack**, and with it `module-path` and the bridger. Corpus first, snapshot
   second, rules third, exactly as step 2 ran. What landed: `packs/typescript/pack.json` and its
   fixture corpus and snapshot (9 nodes, 11 edges); the `module-path` resolve strategy in
   `engine/resolver.ts`; `node.id.indexNames` and glob-aware `tests.paths` in the pack contract;
   repo-relative path-shaped node ids; and `engine/bridger.ts`, which joins the two symbol tables per
   a config `bridge`, so `stats.bridgedEdges` is a real number and `empo index` and `empo doctor`
   both print a per-bridge match rate. `fixtures/acme-platform` gained a second root, `apps/mobile`,
   whose api client calls three routes: one that matches exactly, one that matches only after
   `collapseParams`, and one no route declares, because a bridge fixture where everything matches
   cannot prove the match rate means anything.

   The three interface leaks it found are recorded in [04-language-packs](04-language-packs.md).
   Nothing else in the engine had to move, which was the result the exercise was run to get.
6. **Done: the adapters and `empo review`**, which closes the vertical slice. The command runs in
   two phases, because there is no model call anywhere in the CLI and the agent that works the
   discipline sits between them: `empo review [<pr>]` prints a brief of facts and the shipped
   workflow, and `empo review [<pr>] --findings <file>` runs the verification gate over what the
   agent wrote, prints only the survivors, and tears the session down ([06-cli](06-cli.md)). What
   landed: `adapters/forge/` (`types.ts`, `local.ts`, `github.ts` over the `gh` CLI, `create.ts`)
   and `adapters/tracker/` (`types.ts`, `none.ts`, `github-issues.ts`, `create.ts`, plus `key.ts`
   and `criteria.ts`, the two pieces every tracker shares); `engine/diff.ts` and
   `engine/citations.ts`; `discipline/review.md`, `findings.ts`, `phrasing.ts` and `load.ts`;
   `schema/findings.schema.ts`; `commands/review.ts`; and the refs, worktree and `run` calls in
   `engine/git.ts`, which stays the only module that shells out, so there is exactly one file to
   audit for what this tool executes.

   What it proved: the gate is mechanical. A finding whose anchor is not in the file it cites is
   dropped and a finding whose text hedges is dropped, both by the same answer on every machine and
   every run, and both without a model. A large share of the suite is step 6's, all of
   `test/adapters/`, `test/commands/review.test.ts`, the diff and citation specs and the gate and
   phrasing specs under `test/discipline/`, and the share is stated rather than counted on purpose:
   a test total written into prose is wrong the week after it is written, and this page carried one
   that was. Every line that interprets what `gh` said is a pure exported function, so the whole
   forge and tracker surface is tested with no network and no `gh` installed.

   What it cost: the one path still unproven is posting. `--post` is written, but it has only ever
   run against the local forge, which refuses it by design, so no finding has been posted to a real
   pull request. Everything else, including both phases of the command, its teardown and the
   read-root escape guard, is covered by `test/commands/review.test.ts` and was also run end to end
   against the built bundle on a throwaway git repository built from `fixtures/acme-platform`.

7. **Done: `empo init` and `empo update`**, the on-ramp, and the only commands that write a file the
   human then owns. `init` detects the roots, scaffolds `.empo/`, writes the managed `AGENTS.md`
   block, builds the first graph, then prints a brief of facts drawn from that graph and the shipped
   map discipline beneath it, for an agent to propose flows and spines from.
   `empo init --proposal <path>` gates what the agent wrote and `--apply` writes what survived
   ([06-cli](06-cli.md)). What landed: `engine/detect.ts`, which finds roots from each pack's `match`
   block and reports every candidate it discarded with the reason; `engine/scaffold.ts`,
   which builds the config through the same validator that reads it back and writes only the files
   that are missing; `engine/proposal.ts`, the gate and the writer; `schema/proposal.schema.ts`;
   `host/agents.ts`, the managed block and the merge that preserves every byte outside it;
   `discipline/map.md`; and `commands/init.ts` and `commands/update.ts`.

   What it proved: the two-phase shape is not review-specific. A proposal is a claim in exactly the
   way a finding is, it fails the same way by naming somewhere that is not there, and `checkCitation`
   answers both without knowing which of the two it was handed.

   What it cost: the host wiring it left behind was `AGENTS.md` and nothing else, so the
   machine-owned-file guard and the commit gate were a convention and a CI step rather than something
   that fires while an agent works. Step 8 is the answer to that.

8. **Done: the host wiring**, the three hooks and the `.claude/` configuration that carries them.
   This is the first output in the repository read by a host rather than by a person, and deciding
   what it prints when nothing is wrong (nothing) shaped everything else about it. What landed:
   `host/claude.ts`, which writes the three `empo-*` skill files whole and merges EmPo's hook entries
   into a `.claude/settings.json` that belongs to the repository; `commands/hook.ts`, one command
   over the three events, reading a payload on stdin and answering with JSON or with silence;
   `engine/health.ts`, the facts `empo doctor` renders as prose and `empo doctor --json` and the
   SessionStart hook read as an object; and the second target in `empo init` and `empo update`, which
   is a second module under `host/` rather than a branch inside `agents.ts`, because
   [10-distribution](10-distribution.md) says a new host is a new generator target.

   What it proved: checking beat assuming, and the thing checked was this repository's own design.
   The `/empo:query` these docs had specified for two versions is a *plugin* namespace, a plugin
   needs a marketplace and a per-developer install, and a project's settings can only prompt for that
   install, so the plugin form cannot fire for somebody who merely cloned the repository, which is
   the one thing hooks exist for. Standalone `.claude/` configuration and a hyphen cost the prettier
   name and keep the gate. It also proved the gate needed no second implementation: `pre-commit`
   calls the same function `empo check` renders, so there is one commit gate with two front ends, and
   `engine/health.ts` does the same job for the health answer, so a human and a hook cannot be told
   different things about whether the graph is stale.

   What it cost: ownership by content, because JSON has no marker comment. An entry is EmPo's if its
   `type` is `"command"` and its `command` starts with `empo hook `, which cannot tell an entry EmPo
   wrote from one a human wrote that looks the same, so a hand-wired `empo hook` entry is removed on
   the next update and not restored. That is unfixable at this layer; what is fixable is the silence,
   so every entry taken out and not put back verbatim under the same event and matcher is reported
   for the caller to print. A real change also reprints the whole document and normalizes its
   formatting, which is why "unchanged" is decided on the parsed object and never on the text. And
   every hook fails open where `empo` is not installed, deliberately, which is why `empo check` in CI
   is still the gate that has to hold.

Steps 1 through 5 need no network and no real repository. Everything is provable against synthetic
fixtures, which is exactly the [11-security-boundaries](11-security-boundaries.md) requirement.
Step 6 speaks to a host at runtime and is still proven the same way: every mapping from what `gh`
returned is a pure function over a recorded JSON string, and no test runs `gh` or reaches a network.
Step 7 needs neither again: detection, scaffolding, the brief and the gate are all provable against a
synthetic tree, and the one file init writes outside `.empo/` is an `AGENTS.md` in the repository it
was pointed at. Step 8 is the same shape one level further out: the merge is a pure function from the
text of a `settings.json` to the text of the next one, and a hook's whole answer is a pure function
from a payload object to a string or to null, so the host contract is tested with no host running.

One thing the design docs describe that these steps deliberately did not build, recorded here as
the rule at the top of this doc requires:

- **`empo index --root <path>` is not implemented.** A partial rebuild is only safe while no edge
  crosses a root, and step 5 made that permanently untrue: a bridge edge has one end in each root, so
  rebuilding one root alone would drop or invent cross-language edges, and it would have to merge
  into an existing graph rather than replace it. [06-cli](06-cli.md) describes it and the CLI does
  not offer it. A full rebuild of the acme fixture is milliseconds; this is an optimization waiting
  for a repository that needs it.

Two things step 5 changed that were not on anybody's list:

- **Coverage no longer travels across a bridge between two roots.** The second root made a mobile
  unit test "cover" a backend flow through the route file, and a flow that nothing asserts on stopped
  being reported blind. The rule and the reasoning are in [05-graph-model](05-graph-model.md); it is
  the fixture catching a defect that would have made the tool lie about its most important field.
- **The repo's own toolchain had to be taught to leave the fixtures alone.** A fixture corpus is
  data that must stay exactly as written, byte for byte, and the moment one of them was TypeScript
  the repo's own tools began treating it as source. `tsconfig.json` now excludes
  `src/packs/*/fixtures` (its `include: ["src"]` was demanding React types for a file that exists
  only to be regex-matched) and `biome.json` now excludes `fixtures` as well as
  `src/packs/*/fixtures`. Biome is the one that would have done real damage: `organizeImports` is on,
  and reordering the imports in a fixture moves the very line numbers the expected snapshot pins.
  `vitest.config.ts` needed nothing, because it only collects `test/**`. Any future language whose
  fixtures are written in the same language as this repo will need the same treatment.

Six things step 6 decided, recorded so none of them is reopened without new facts:

- **A review's scratch lives in the OS temp directory, never under `.empo/`.** `session.json`, the
  `pr-<id>.diff` and the detached worktree all sit under `empo-review/<id>` in the system temp
  directory. `generated/` is machine-owned by `empo index` alone
  ([02-on-disk-layout](02-on-disk-layout.md)), and invariant 2 of
  [07-review-discipline](07-review-discipline.md) is taken literally: a review writes nothing into
  the working tree it is reviewing. The one thing it does write there is git's own worktree
  bookkeeping under `.git/worktrees/`, which `git worktree remove` clears at teardown, and which is
  the price of reading a branch without disturbing the checkout.
- **A drifted citation is repaired, an absent one is fatal.** A finding whose anchor is not on the
  cited line but is somewhere else in the same file survives, reported against the line the anchor is
  really on, because the quoted source is there and only the coordinate moved. A finding whose anchor
  is nowhere in the file is dropped, because the claim stands on text that does not exist. The two
  mistakes are different and the author fixes them differently, so the gate answers them differently.
- **Findings dedupe by `(kind, file, line)`, and a finding claims its line only once it is
  verified.** This was a real defect. The first version deduped against everything submitted, so a
  fabricated or hedged finding that happened to sort first silently took a real finding on the same
  line down with it as a "duplicate", which inverts a gate that exists to drop unchecked claims and
  never to swallow a checked one. Found by reading `gateFindings` with the suite green, and fixed
  with tests that fail against the old behaviour. The kind is part of the identity because a defect
  and a missing test citing one line are two claims about it, not one.
- **The forbidden-phrasing lint deliberately omits doc 07's callee-behaviour family.** "X never
  saves", "does not persist", "returns null" is exactly what a *verified* finding says once the
  callee's body has been read, no regex can tell whether it was read, and banning the wording would
  delete true findings and teach agents to write vaguer ones to slip past the lint. The citation gate
  enforces that rule instead: the claim ships only if it quotes a real line of the callee. This is
  the one red flag in [07-review-discipline](07-review-discipline.md) the lint does not carry, and
  the gap is reasoned rather than an oversight.
- **The five host-specific adapters became one `mcp` kind on each side.** The `bitbucket` and
  `gitlab` forges and the `jira`, `asana` and `linear` trackers were specified in
  [09-adapters](09-adapters.md) as speaking each host's MCP server, which this CLI cannot do: MCP is
  driven by the agent host, whose connectors authenticate interactively, and nothing here makes a
  model call. So the fetch moved to the agent and the checking stayed here. `empo review` prints the
  shape it needs, the agent writes JSON, and `adapters/host-input.ts` validates it and resolves both
  branch names against real git before any of it is believed. A payload naming a branch this
  repository does not have fails before the review starts, which is what makes a fetched pull request
  worth reading. An `mcp` adapter with no payload yet degrades to `local` or `none` with a note in
  those words, for the same reason the older adapters did.
- **`.empo/generated/` is filtered out of the reviewed diff.** A team that commits its graph would
  otherwise find `graph.json` in every diff, burying the files a human changed under a machine's
  output. The count and the paths are reported as a note, so the omission is stated and not silent.

Seven things step 7 decided, recorded the same way:

- **`empo init` prompts for nothing, and the two questions in
  [02-on-disk-layout](02-on-disk-layout.md) became two flags.** Where the config lives is
  `--config-at-root`; whether `generated/` is committed is `--commit-generated`. A command that
  prompts cannot run in a hook, in CI, or under an agent, which is precisely where a scaffolding
  command earns its keep, and both questions have a defensible default a human can change afterwards
  in a file they own. The `--yes` [06-cli](06-cli.md) used to list went with them: there are no
  prompts left to accept, so the flag would have done nothing, and a flag that does nothing teaches a
  false model of the command.

- **Nothing is ever overwritten, and there is no `--force`.** A file init would write and finds
  already there is reported `kept` and left byte for byte. That turns a second run into the repair
  for a half-scaffolded repository instead of a way to lose a tuned config, approved flows and a
  register that grew over months of reviews, none of which is reproducible from a file listing. The
  spine writer asks the same question a second time at `--apply`, because a spine of that name can
  appear between the verdict a human read and the command they ran after reading it.

- **The generated config states what it cannot know instead of guessing at it.** No `framework`,
  because nothing in a pack's `match` carries a framework signal and a generated hint would put a
  language specific inside the engine. No guessed `adapters`: the section is written only from
  something observed, the forge `detectForge` read out of the origin remote (as configured, since
  `git remote get-url` expands `insteadOf` rewrites and a proxy is not a host) and the tracker host
  `empo init --tracker` was given, and it is left out entirely when neither is known rather than
  emitted empty, because `"adapters": {}` reads as a section somebody configured and then emptied.
  An absent adapter is not a broken one, it degrades gracefully, and the `AGENTS.md` block then
  names which half is missing and what a review therefore cannot know.
  And `"bridges": []`, because a bridge is a claim that two roots exchange a symbol under a
  normalization rule and neither half of that is visible in a file listing. Only the last one gets a
  printed note, and only when there are two or more languages: cross-language reach reads as zero
  until a bridge exists, which is indistinguishable from a repository that genuinely has no coupling.

- **The seeded `ignore` leaves test files in, and the example in
  [03-config-schema](03-config-schema.md) was a defect.** That example listed `**/*.test.ts`, which
  contradicted the prose two paragraphs below it. Following it would have made `empo query --blind`
  call every flow in the repository blind and `empo check` find no assertion anywhere, which is both
  of this tool's headline answers turned into noise by one plausible-looking glob. The doc is fixed
  and init seeds five patterns: `node_modules`, `vendor`, `dist`, `build`, `coverage`. Detection's
  own walk skips one more, `.empo/`, because EmPo's own directory is derived and curated state and
  never a root.

- **One invented coordinate drops the whole spine, where a review drops only the finding.** The
  asymmetry is deliberate. A findings list is read one finding at a time, so dropping the bad one
  leaves the rest usable. A spine is read as a map, by somebody locating themselves before touching a
  chain where mistakes are expensive, so one coordinate that leads nowhere turns every other
  coordinate in the file into a question, and a map that has to be re-verified before use is worth
  less than no map. The skeleton still comes back in the verdict, named, so nothing is lost; it is
  simply not written.

- **`empo update` owns a block, not a file.** `AGENTS.md` belongs to the repository and EmPo is a
  guest in it, so the generator replaces what lies between its two markers and appends when it finds
  none. Anything other than exactly one pair in order is refused with a count, because both silent
  answers are wrong: replacing the first pair leaves a stale second copy of the instructions the
  block exists to keep current, and replacing from the first marker to the last deletes whatever a
  human wrote between the pairs. A byte-identical merge reports `unchanged` and writes nothing, which
  is what makes the command safe in a hook.

- **The map discipline ships as data beside the review discipline, and the proposal is scratch.**
  `discipline/map.md` is loaded by `mapWorkflow()` exactly as `review.md` is by `reviewWorkflow()`,
  so a team can read, diff and version the workflow their agent was handed, and the generated
  `/empo-map` skill becomes a shortcut over the CLI rather than the place the workflow lives. The
  proposal file itself goes to the OS temp directory and never under `.empo/`, the rule a review's
  scratch already follows: `.empo/` holds what a human approved, and a proposal is a draft passing
  between two processes.

## Testing discipline for this repo

- **Pack tests are snapshot tests** against synthetic fixtures. A new language pack is accepted only
  when `empo pack test <lang>` passes. This is the phase-3 gate for community packs and it applies
  to the built-in packs from day one.
- **Engine tests** target `extractor`, `resolver`, `bridger`, `coverage`, and determinism in
  isolation, with tiny inline inputs.
- **Integration tests** run whole commands (`index`, `query`, `doctor`) against `fixtures/acme-platform`.
- **No test may reference a real target codebase.** Fixtures are the fictional acme-platform only.

### The pack fixture convention

`empo pack test <name>` implements one layout, and every pack follows it:

- `src/packs/<name>/fixtures/src` is the synthetic source tree. It is built as its own repository
  root, a single root with `path: "."`, so the `file` and `evidence` paths in the snapshot are
  corpus-relative and identical wherever the repo is checked out.
- `src/packs/<name>/fixtures/expected.json` is the snapshot of what a pack produces, the `nodes`,
  `edges`, `hazards` and `names` `build.ts` returns, serialized with two-space indent and a trailing
  newline. A snapshot written before the hazard axis existed carries no `hazards` key and reads as an
  empty list rather than as a failure, because it was written by a pack that declared no hazard rules
  and the empty list is what such a pack produces. `names` follows that rule and deliberately not the
  one `Graph.names` follows, whose absence has to stay readable: a snapshot is regenerated from a
  corpus this repository owns, so the counts arriving read as a diff somebody reviews rather than as
  an answer served about a repository.

A mismatch is a gate: exit 1, with the differences printed one per line (missing, unexpected and
changed nodes, missing, unexpected and moved edges, missing, unexpected and changed hazards, and the
same three for a family's name counts, keyed on the family because that is the unit the tally has one
record of) so the failure names what to go read. A hazard is keyed on its dispatch site rather than
on the whole record, so a hazard whose `target` stopped resolving reads as one changed line and not
as one disappearing and another appearing, which is the difference between "the job resolution rule
broke" and "a hazard came out of nowhere". A pack that does not exist, a fixture tree that does not
exist and a missing `expected.json` are config
errors and exit 2, because none of them is a claim about the pack's behaviour.

`empo pack test <name> --update` rewrites the snapshot instead of diffing it. Run it only after
reading every line the failure printed. A snapshot updated without that reading is a test that
asserts whatever the code did.

### Two things about writing a rule, both learned by getting them wrong

Both came out of the typescript pack's JSX tag rules, both were found by review rather than by the
suite, and both generalize past that pack.

**An `edges` rule's reach is the whole pack, not the dialect it was written for.** A rule is written
while looking at one kind of file and then runs over every file `match.extensions` claims. The
typescript pack matches seven extensions of which two can hold JSX, so a tag rule written for `.tsx`
also read `.ts`, `.js`, `.mjs` and `.cjs`, where a component name inside a quoted string is not a tag
and nothing was blanking string contents. The result was a real edge out of a documentation constant,
and because coverage travels along every non-bridge edge, the same string in a test would have made
that test reach a component it never mounted. `pathGlob` on an extract rule is the fix and the general
answer: a rule that is about a dialect says so.

That glob closed four extensions and left the fifth open, and closing it took the masker learning to
answer per rule (typescript pack 1.6.0). `const tip = "<Button />"` written in a `.tsx`, `.jsx` or
`.vue` file produced the same phantom `template` edge to a file it neither imports nor renders, and
no glob could refuse that one, because that file is exactly the file the tag rules exist to read.
`maskComments(source, syntax, maskStrings)` now blanks the **contents** of every string literal as
well when asked, keeping the quote characters, the length and the newlines so every line number
downstream is unchanged, and `maskStrings?: boolean` on an edge rule (`schema/types.ts`, validated in
`extractRuleSchema`) is how a rule asks; absent is the previous behaviour. It is per rule and not per
family deliberately: php's `template` family holds both `<x-cart>`, which is markup, and
`@livewire('cart')`, whose whole answer lives inside the quotes, so a family-wide switch would break
the second. At that point only the typescript pack's two `template` rules declared it, and the php
pack is untouched by this change and by the one below.
`engine/extractor.ts` builds the second code-only view once per file and only when some rule asked
for it, and each rule reads the view it declared. The price is a new false negative in two shapes: a
tag between two apostrophes on the same line of JSX or Vue prose, which stops at the line end because
`'` is not in `multilineQuotes`, and a tag between two literal backticks, which does not stop there
because `` ` `` is. The second is the wider one and was understated when this was first written.
Regenerating the typescript fixture snapshot produced only additions, so
no edge that was ever real was lost.

**The label was the other half of it and it shipped as a defect for one release** (typescript pack
1.7.0 closes it). `maskStrings` was an edge-rule field only, `kindRules.contentPattern` read the
comment-masked source and no other view, and so a `.tsx` whose only tag-shaped text sat inside a
string was kinded `component` though it rendered nothing. That is not cosmetic, which is the part
worth writing down: `resolveName` in `engine/resolver.ts` (`uniqueId` when this was written) gates
every `short-name` resolution on the target's kind, so `targetKinds`, the clause that exists to
refuse a tag landing on a same-named non-component, reads the one field the defect corrupted. The
over-promoted file became an eligible tag target and the refusal stopped working with nothing said.

The fix is the same field on the other rule kind. `maskStrings?: boolean` is now on `PackKindRule`
in `schema/types.ts` as well as on an extract rule, and `kindOf` in `engine/extractor.ts` takes both
views and picks per rule rather than taking one. A `wantsCodeOnly` helper decides whether the second
view is built at all, and it asks the edge rules **or** the kind rules, so a pack whose only asker is
a kind rule still gets the view and a pack with no asker anywhere still pays nothing. Per rule and
not per family for the reason the edge side already had: a pattern describing code asks, a pattern
keying off a string the framework itself reads must not.

Two refusals at load, both in `pack.schema.ts`. `maskStrings` on a kind rule declaring no
`contentPattern` is rejected, because that rule reads no source and the flag would sit there inert
while reading as a guarantee that the kind cannot come from a string. And the existing "needs a
comment syntax declaring `stringQuotes`" check now walks `node.kindRules` after `edges`, so both rule
kinds get the same answer from the same masker. That second check is **per extension**, because a
pack-wide one is a floor rather than a guarantee: it passes if any one syntax names a quote, while
`commentSyntaxFor` picks per extension, so a pack declaring quotes in `comments` and omitting them
from `commentsByExtension[".tsx"]` would load clean with the flag inert for every `.tsx`. Instead
each declaring rule's reach is resolved: candidate suffixes are `match.extensions` plus every
`commentsByExtension` key, a `pathGlob` narrows them (tested against both a bare and a nested
synthetic path, since a glob answers those differently), and each survivor is resolved by the same
longest-declared-dotted-suffix rule `commentSyntaxFor` uses. Taking the keys as candidates is what
makes a compound extension visible: `.blade.php` is in no `match.extensions` and `extname` calls it
`.php`, so a check reading either alone would miss the entry that really masks the file. The message
names the offending extension, which is the only thing the pack author can act on.

The price is the price the edge side accepted, moved onto the label, and in the same two shapes: a
`contentPattern` whose only match sits inside an apparent literal is blanked with it, and where that
literal is opened by a backtick it runs across lines rather than stopping at one. That file falls
through to `module`. Under-reporting a kind costs a refused
tag, which is a missing edge; over-reporting it costs a waved-through tag, which is an invented one.

**A name-resolving strategy is only as safe as the namespace it resolves into.** `short-name` was
built for Blade, where a `<x-price-badge>` names something in this repository by construction, and it
is safe there for that reason rather than by its own logic. A JSX tag's namespace is mostly other
people's packages, so `<View>`, `<Link>` and `<Text>` name nothing here, their vendor imports resolve
to no node and leave no competing edge, and a local file that happens to share the basename collects
the coupling instead. `targetKinds` narrows what a name may land on, and the order it is applied in
was itself the second defect: filtering the candidates before asking whether the name is unique turns
a refusal into a confident wrong answer, so uniqueness is asked first and the kind filters the
survivor. Before reusing a strategy in a second language, ask what its namespace is there.

## The name tally, and the silence it ends

This is the next chapter of the paragraph above, and it is a separate lesson because the refusal it
is about was never wrong. `resolveName` in `engine/resolver.ts` (it was `uniqueId`) returns nothing
for a short name carried by more than one node, which is the right answer: it drops rather than
invents, and the alternative is a confident wrong edge. What it did on top of that was say nothing.
The call sites simply skipped pushing the edge, and nothing in `engine/health.ts` or
`commands/doctor.ts` counted the skip or printed it.

**The refusal is per name and not per reference**, which is what makes the silence expensive. One
duplicate basename anywhere in a root removes every edge to that name, including the ones written in
a file whose own import is unambiguous and whose author could not have known any of this happened.
Measured on a synthetic 16-file React tree: a second `OrderTable.tsx` under another feature directory
took it from 12 template edges to 7, in silence, no hazard, `empo doctor` OK. On a 640-file copy
where every component name was 40-way ambiguous, zero template edges resolved at all. `targetKinds`
does not change that arithmetic, and it is worth stating because the paragraph above can be misread
as saying it does: the ambiguity test runs first, and the kind filter applies to whatever survives
it.

**Two directions were on the table and only one shipped, so say plainly which.** The first was to
narrow the refusal, by letting an ambiguous name resolve against the imports the same file already
declares. The second was to count the refusals and print them. The second shipped. The narrowness is
untouched: a family whose yield is zero still yields zero, edge for edge, and the only thing that
changed is that it now says so. Read the counts as a measurement and never as a repair. What they
buy is that the first direction is now decidable from a number instead of from an argument, and that
"found nothing" and "there was nothing to find" have stopped printing the same way.

The mechanism, and why each piece is where it is:

- **`resolveName` returns `{ id, outcome, candidates }` instead of a bare `string | null`**, so the
  three ways to answer null stay three answers: a name in no node is a vendor component and costs
  this repository nothing, a name of the wrong kind is a rule's own `targetKinds` doing what it was
  declared for, and a name in several nodes is a coupling that exists and is not in the graph. As a
  bare null they were indistinguishable downstream, which is exactly how a collapsed family looked
  like a family with nothing to find. (Three at the time. `local` made it four and `vendor` five, and
  the section below is what those two are for.)
- **`resolveEdges` returns `ResolvedFile { edges, names }` rather than `GraphEdge[]`.** The names
  travel with the edges rather than through a second pass, because a second pass would be a second
  place deciding whether a name is ambiguous, and two answers to that would be a defect invisible
  from either one. It is the argument that already makes `observer` and `short-name` share one
  helper, applied one layer out.
- **Both of an `observer` capture's names are read unconditionally.** `&&` would have short-circuited
  and hidden the second name's verdict behind the first one's refusal, so a registration whose
  observed class is ambiguous would have gone on under-reporting the listener.
- **`src/engine/names.ts` is new: `tallyNames`, `mergeNames`, `nameLines`.** The renderer lives beside
  the arithmetic because `empo index` and `empo doctor` both print this block and two copies of the
  sentence would drift, which is the rule `bridgeLines` and `driftLines` already follow. `empo query`
  prints it too now, and that was the surface the block was missing: index and doctor are read when
  somebody is setting empo up, and the reader who is about to act on a blast radius is looking at
  neither. On the React Native application below, `template` resolved 3 of 1531 tag references and
  `empo query` said nothing about it, so a radius whose component edges had almost all been refused
  printed exactly like a complete one. A thin answer is not a wrong answer, but it is
  indistinguishable from a full one unless the yield prints beside it. `query` filters to the
  families that read at least one name: the two silences `nameLines` keeps apart, nobody counted and
  nothing read a name, are facts about the graph rather than about the node being queried, and index
  and doctor already say them.
- **The tally happens before `dedupeEdges`, deliberately.** An edge deduplicated away was a reference
  the rules did read and did resolve, so counting after would shrink the numerator while leaving
  every refusal standing, and report a yield lower than the one that was measured.
- **Across roots, counts sum but candidate counts take the max.** Ambiguity is decided against one
  root's index, so the number a reader will actually find when they go and look is the larger of the
  two, and summing them would report more files than any single refusal ever weighed.
- **`Graph.names`, schema 4 → 5, with absent-versus-empty handled the way `hazards` is** and for a
  sharper reason. The empty list is a real answer this field carries, "no rule in these packs
  resolves a name", so a reader that defaulted a missing key to it would recreate, inside the field
  built to end the silence, exactly the silence it ends. A graph written before the count says so.
- **Schema 5 → 6, and the plainest case for a bump there is, twice over.** `resolved` kept its name
  and changed what it admits: after the case fold below it counts names a node carries in another
  case, so every `resolved` written under schema 5 was measured against a stricter rule and the two
  numbers cannot be compared. That alone is the bump. `names` also gained `local` and, inside the
  same unreleased bump, `vendor`, which is the
  `hazards` argument one field deeper: a schema 5 graph has no `local` key because nothing ever
  asked whether a file declared the name it rendered, and no `vendor` key because nothing read a
  manifest, and defaulting either absence to zero would read
  as a clean bill of health invented out of a field nobody wrote.
- **`Health.names` is a fact block and never a `HealthFinding`**, on `flowHealth`'s argument: the
  SessionStart hook prints every finding every session, and ambiguous component names are the normal
  shape of a React tree with feature directories. A warning that fires forever on a deliberate state
  is a warning somebody turns off. The number is the whole of the answer; whether it is the right
  number is the human's judgement.

**`FixtureSnapshot` gained `names`, and that is the only possible gate on a silent refusal.** No edge
disappears from a diff that was never there, so a corpus whose yield went to zero produces a snapshot
that looks exactly like a corpus with nothing to find, and `empo pack test` was structurally unable
to notice. Pinning the counts puts the refusal itself under the gate: a rule that stops resolving, or
a fixture that quietly makes a name ambiguous, now fails here rather than in somebody's repository.
The typescript corpus gained a `<Spinner />` in `react/cards/OrderCard.tsx` for the reason the
fixture lesson above already states, that a snapshot catches only what its corpus contains: `unknown`
was the one verdict of the four that corpus never reached, so the separation between "in no node" and
"in several nodes" was ungated until a tag naming nothing at all existed.

## What the counts then said, and the four repairs they paid for

The section above ends by insisting the counts are a measurement and never a repair. This is what the
measurement said once it was pointed at real repositories, and the four repairs it justified. All
four are in the typescript pack and in `engine/resolver.ts`, the third and fourth also in the new
`engine/packages.ts` and one line of `engine/build.ts`; none touches the ambiguity rule, which
is still the largest refusal there is.

**The case fold, and why it is a fallback and not the index.** `short-name` looked a tag's spelling up
in `byShortName`, which is keyed by the node's name exactly as the file is spelled, and that made a
file naming convention into a language. `<Badge />` is written `Badge.tsx` in one React repository and
`badge.tsx` in the next, and both are a component the graph holds. The number is the argument: on a
real 186-file React Native application whose component files are all lowerCamelCase, `template`
resolved **3 of 1531** tag references, and every one of the 1528 misses was `unknown` — not one was an
ambiguity anybody could have repaired by renaming a file. A strategy that reads 0.2% of the references
in a repository it was designed for is not a strategy that repository has. `NodeIndex` gained
`byFoldedName`, the same index keyed by the lower-cased name, and `resolveName` reads
`byShortName.get(n) ?? foldedCandidates(index, n).filter((id) => importsNameFrom(n, id))`. On that
application the same rules then resolved **735 of 1531**, with 795 in no node and one `local`.

It is consulted **only** when the exact spelling is in no node, and that ordering is half the safety
argument rather than an optimization. A repository that spells its files as it spells its tags is
answered by the exact map on every reference and can never be handed a fold, so it cannot pay for a
convention it does not use. `targetKinds` still filters the survivor after the uniqueness question, in
that order, for the reason the paragraph on `<Link />` above gives.

**The other half is the `filter`, and it is what a first version of this went without.** A tag spelled
exactly as a file is the language's own convention answering; a fold is the engine guessing that a
naming style is in play, and a guess needs a witness. So an exact match resolves unwitnessed and a
folded candidate has to be corroborated by the rendering file's own imports: `importsNameFrom` in
`resolveEdges` walks that file's `module-path` captures and keeps the candidate only where a capture's
statement text binds the name (group 0, the `import` as written) **and** its specifier resolves through
`resolveModulePath` — relative paths and the root's configured aliases — to exactly that candidate id.
No new pack rule is needed for any of it: the `import` captures are already there.

The number is again the argument. cal.com names its shadcn-style files `toaster.tsx`,
`collapsible.tsx` and `textarea.tsx`, and the uncorroborated fold produced **53** extra template edges
there of which a sample of 6 was **5 wrong** — `<Toaster />` imported from the `sonner` package
landing on the local `toaster.tsx`, `<Collapsible>` from `@radix-ui/react-collapsible`, `<TextArea>`
from a `@calcom/ui` barrel whose real file is `inputs/Input.tsx`. Corroboration removed **46** of the
53, every refuted one among them, and kept the one real edge
(`apps/web/app/layout.tsx:167 -> apps/web/app/providers.tsx`, imported as `./providers`). On the React
Native application, where the tags do name those files, **12 of 12** sampled edges survive, each opened
at its cited line and confirmed real.

Two things follow from where the filter sits, and both are worth stating because neither is the rule
the exact map follows. It runs **per candidate and before the uniqueness test**, so a name two files
carry once case is set aside still resolves where the reading file imports exactly one of them: that
is not the ambiguity the exact map refuses, since there nothing in the file says which is meant and
here the file has said. And a fold no import corroborates never becomes a candidate at all, so it ends
as `unknown` rather than `ambiguous` — nothing was weighed. What it costs is the component rendered
with no import whatsoever, a globally registered Vue component, which is reachable through an exact
name and never through a fold.

The fixture corpus pins the halves: `cardFooter.tsx` is rendered as `<CardFooter />` from
`CardShelf.tsx`, which imports it as `./cardFooter`, so the fold and its witness are both under the
snapshot, while `CardHeader.tsx` beside it is spelled as its tag and is answered by the exact index
with no witness asked for, which is what proves the fallback is a fallback.

**`declares`, because the one file the index never asks is the file doing the asking.** A
name-resolving strategy asks the whole root which file carries a name. It has never asked the file
that wrote the reference, and that file is the one with the strongest possible claim: a story file
holding its own `const SelectInput = ...` three lines above a `<SelectInput />` is not rendering
anybody else's `SelectInput.tsx`, whatever the root's index says. Before this, it collected an edge to
a file it neither imports nor renders, and a reader following that edge landed somewhere unrelated. On
marmelab/react-admin that was **139 of 2715** template edges.

So packs gained an optional `declares`: an array of regexes whose first capture group is a name the
file declares itself, one per shape the language spells a declaration in — the typescript pack
declares three, for `function`, `class` and `const|let|var`. Which spellings declare a name is a fact
about a language and not about a repository, which is why it lives in `pack.json` beside `comments`
and `edges` rather than in config. `compilePack` compiles them `"gm"`, `extractFile` runs them over
the comment- and string-masked `codeOnly` view on the same argument the tag rules make (a declaration
quoted inside a string is prose about a declaration, not one), and `declaredNames` dedupes and sorts
the captures so two runs over the same bytes write the same `graph.json`. A pattern that matches and
captures the empty string contributes nothing, which is worth stating as a rule rather than a guard: a
pack's own bug is not a declaration, and admitting `""` would put the empty string in the declared set
of every file the pattern touched and make that pack refuse every name it read.

The result is `ExtractedFile.declares`, a property of the file rather than of a capture, because that
is the shape of the question. `resolveEdges` builds `new Set(file.declares)` once per file and
`resolveName` checks it **last**, after uniqueness and after `targetKinds`, of the one name that was
about to become an edge. The first version checked it before the index and that was the wrong
ordering, argued rather than measured: it read as "a name answered inside the file is answered there
whatever the index holds", which is true and beside the point, because a name in no node was never at
risk of a wrong edge. What it produced was every locally declared helper in the repository counted as
a refusal — 2753 references on react-admin, against 213 under the shipped order — and a refusal
count that large reads as a repairable loss when it is nothing of the kind. Asked last, `local` fires
only where the index found exactly one node, of a kind the rule allows, and the file that wrote the
reference declares that name itself; it comes back with `candidates: 1`, because one node was weighed
and then declined. `nameLines` prints it as `N declared where they are used`, and it
reads as a refusal in the tally that is worth reading as a repair: this one prevents a wrong edge
rather than losing a right one, which is the opposite direction from `ambiguous`.

The corpus pins both halves in `CardStory.tsx`, which declares its own `OrderCard` and also renders
`<CardHeader />`: the shadowed name is refused and the one the file does not declare still resolves,
so the rule is about the name and not about the file. It shadowed `CardFooter` until the ordering
moved, and that edit is the ordering showing up in the fixtures rather than a cosmetic one:
`CardFooter` reaches the index only through the fold, `CardStory.tsx` carries no import to corroborate
that fold, so the reference is honestly `unknown` and never reaches the `local` check at all.
`OrderCard.tsx` is carried by the exact index and kinded `component`, which is the only shape that
gates the verdict.

**`packages`, because the one thing an exact match cannot see is whose code the name is.** A tag whose
component comes from a **package** whose name collides with a local file's basename resolved to the
local file: `import Button from '@mui/material/Button'` beside a local `Button.tsx` was **189 of
react-admin's then 2715** template edges. Every question the strategy asks answers yes — one node
carries the name, spelled exactly, of the right kind, in one place — and `declares` does not help
because the file declares nothing, it imports, while the fold's corroboration bounds the guessing to
the fold and never reaches an exact match. The one fact that separates the two cases is not in the
source at all: `@mui/material` is a package this repository installs, and the repository writes that
down in a manifest.

`engine/packages.ts` is the whole of the reading. `readPackages(repoRoot, source, ignore)` globs
every manifest the pack's `packages` block names, honouring the config `ignore` list, and returns the
**dependency names minus the manifests' own names** as `vendor` (and those own names mapped to their
directories as `internal`, which is the next repair below); `packageOf(specifier)` turns a specifier
into the package it names, two segments for a scoped one and one for the rest, which is npm's own
rule and why `@mui/material/Button` and `@mui/material` answer the same. `buildRoot` calls it once per
root, with that root's pack's block, and puts both on `ResolveContext`; the glob itself runs from the
repository root, so what is per root is which manifest basename gets read rather than which subtree,
and php, declaring no block, gets an empty set and resolves byte-identically to
before. `importsVendorName` in `resolveEdges` reuses `statementBinds`, the same escaped
word-boundary test `importsNameFrom` was already built out of — which also refuses a name the import
statement renames away — and asks whether any `module-path` capture in this
file binds the name and names a package in that set. `resolveName` asks it last, beside `local`, of
the survivor of uniqueness and `targetKinds`, for the same reason and with the same `candidates: 1`.

**Both halves of the subtraction are load-bearing and dependencies alone would have been a
regression.** A monorepo imports its own workspaces exactly as it imports npm — `@calcom/ui`,
`react-admin`, `ra-core` — so a rule that refused every bare specifier would delete precisely the
barrel-reached edges this family exists for. And no module resolution happens: an installed tree is a
build artifact a fresh checkout does not have and CI may prune, so a graph whose refusals depended on
it would answer differently on two machines sitting on the same commit. A manifest is checked in.
`node_modules` cannot reach this at all: the glob prepends `**/node_modules/**`, `**/vendor/**` and
`**/bower_components/**` to the config's `ignore` rather than trusting it to hold them. The failure it
closes is silent and inverted — an installed manifest declares its own `name`, and `readPackages`
subtracts `own` from `dependencies`, so a read of `node_modules` removes `@mui/material` from the set
that exists to refuse it. A repository that trims its `ignore` list would lose the refusal and see
only a yield that went up.

**The yields went down on three of the four repositories, and that is the result.** That build had
react-admin at **7165 of 17415** with **3386 ambiguous**, against 7672 on the build before it, and
the references that moved were resolving to the wrong file: of the six edges independent checkers
refuted in the sample of 38, four are refused — two MUI collisions, one radix collision, one
same-file `const`.

**The same manifests, read a second way, are what closed the workspace collision.** It is the one
case the `vendor` refusal can never reach, because a workspace name is one the repository *is* and
the vendor set subtracts it precisely so barrel-reached edges survive: cal.com's
`apps/web/modules/webhooks/components/WebhookListItem.tsx:222` renders `</Button>` under
`import { Button } from "@coss/ui/components/button"`, `@coss/ui` is `packages/coss-ui`, and the edge
landed on `packages/ui/components/button/Button.tsx` because that is the one node named exactly
`Button`. What the manifests also say is where `@coss/ui` lives, so `readPackages` returns the own
names mapped to the directory each manifest sits in beside the vendor set — one pass, since the glob
is the expensive half and the two answers are one subtraction seen from either side — and
`ResolveContext` carries both.

**The rule is a preference and never a requirement, and that distinction is the whole design.**
`resolveName` asks `insidePackage` first: where the statement that binds the name names an internal
package whose directory is known, the nodes under that directory are searched, exact spelling and
then the case fold, and exactly one of a kind the rule allows is the target. Anything else falls
straight through to the index with nothing changed. The obvious version — require the resolved
candidate to live under the named directory — reads like the same rule and deletes real edges:
react-admin's `packages/react-admin` is a barrel whose `index.ts` re-exports `ra-ui-materialui` and
`ra-core`, so `examples/crm/src/deals/DealList.tsx:105 ->
packages/ra-ui-materialui/src/layout/TopToolbar.tsx` is a component legitimately living in another
package's directory. Searching that barrel finds nothing, which is what makes falling through the
right answer rather than a softened one.

It is a **redirect and not a refusal**, so the outcome stays `resolved`, no verdict counts it and no
`NameVerdict` was added: the reference did become an edge and only its target moved, and a count of
that is a count of nothing a reader can act on. Three details are worth keeping. The subtree fold
needs no separate witness the way `foldedCandidates` does, because the import that selected the
subtree is that witness — which is the only way `<Button />` reaches a file named `button.tsx`. The
binding is read through `statementBinds`, the same escaped word-boundary test `importsVendorName`
uses, so a name an import renames away selects no subtree either. And the redirect is asked **before**
`local` rather than after it, which was measured: guarding it on the declared set cost five cal.com
edges, and all five were
`const AlbyPriceComponent = dynamic(() => import("@calcom/app-store/alby/components/AlbyPriceComponent"))`
— the file declares the name, and the thing it declares is a wrapper around an import of exactly the
file the redirect finds.

**Where that left the numbers, and nothing was lost.** react-admin **7409 of 17415** with **3142
ambiguous**, 5617 in no node, 527 of the wrong kind, 213 `local`, 507 `vendor`; cal.com **2777 of
5917** with 240 ambiguous, 2822 in no node, 9 of the wrong kind, 46 `local`, 23 `vendor`; excalidraw
**563 of 1264** and the React Native application **735 of 1531**, both byte-identical to the build
before, neither being a monorepo. **No repository lost an edge**: 60 added on react-admin, 138 added
and 35 retargeted on cal.com, none removed anywhere. A sample of the moved and added edges was opened
at its cited lines by independent checkers told to refute each one.

**One residue is left deliberately.** A dotted tag contributes its head, so excalidraw's
`<DropdownMenu.Trigger>` resolves to the file holding the namespace object rather than the one
holding the component.

And the ambiguity refusal moved for the first time here, though only where a workspace boundary
answers it: react-admin 3386 to 3142 and cal.com 515 to 240, every one of them a name two files carry
and an import that says which package it came out of. Everywhere else the share is still references
dropped because two files hold the name and nothing in the reference says which.
Those are floors and they are meant to be read as floors. The four repairs here moved a repository
that had no component graph at all into having one and stopped two classes of edge that pointed at the
wrong file; they did not make `short-name` a resolver, and the number that would have to move for it
to become one is the ambiguous count. That is where the first direction of the two on the table above
— resolving a name against the imports the same file already writes — is now half taken: an import is
read on the exact path to refuse (`vendor`) and to choose between candidates in different workspace
packages, and never yet to choose between two candidates inside one. The ambiguity refusal is still
mostly undecided, now with a denominator attached and with the monorepo half of it answered.

## Coding conventions

- ESM, named exports, no default exports except where a framework needs one.
- Every command returns a numeric exit code via a thrown typed error caught in `empo.ts`, matching
  the exit-code table in [06-cli](06-cli.md). Do not call `process.exit` deep in the engine.
- The engine is pure where it can be: functions take inputs and return graph pieces, side effects
  (reading files, writing `graph.json`) live at the edges in `scanner` and `graph`.
- No LLM calls anywhere under `engine/`. The mechanical layer is deterministic by construction; if
  something wants a model, it belongs in `commands/init.ts` or `commands/review.ts`, never lower.
  `empo review` turned out to want none: it prints facts, the agent executing it works the
  discipline, and it gates what comes back, which is why the command has two phases rather than a
  model call in the middle. `empo init` turned out the same way and for the same reason, so the CLI
  makes no model call anywhere and both commands are shaped alike: a brief, an agent, a gate.

## How to work here, learned the hard way

Grouped, because the list is long and the groups are what generalize. A lesson is expensive to learn
and outlives the work that learned it, and this is the doc that records why decisions here went the
way they did.

Where a lesson was learned against a codebase that is not this one, only the shape of the mistake is
stated, per [11-security-boundaries](11-security-boundaries.md): that is the transferable part, and
the codebase's identity is not.

### Claims about other people's software are the cheapest to check and the most expensive to get wrong

- **Check the host's contract against the host's documentation before building to it.**
  [10-distribution](10-distribution.md) specified a Claude Code plugin across two revisions of this
  corpus, and one hour of reading showed the plugin form cannot fire for somebody who merely cloned
  the repository, which was the entire reason the section existed. [09-adapters](09-adapters.md) then
  specified adapters speaking MCP from a CLI that cannot reach MCP. Both survived review because
  everyone inside the design agreed with them. Code built on such a claim looks correct and does
  nothing.
- **Desk research is not verification.** Research from a forge's swagger concluded a pull request has
  no top-level `description` and warned that reading it would silently yield nothing. One live call
  disproved it: the swagger describes a different surface than an agent actually sees. When a doc
  names another system's field, read the field.
- **A wrong fact travels further than a wrong line of code.** A claim that one tracker's ids are 16
  digits and past `MAX_SAFE_INTEGER` was false by a factor of seven. It went from research into a
  brief into a test comment, where it justified a correct test with a wrong reason. One agent given
  the same fact checked it and wrote the accurate version, which is the only reason it surfaced.
- **Ask what is undocumented, not just what is documented.** Whether a PreToolUse hook honours
  `additionalContext` with no `permissionDecision` is stated nowhere. Knowing it was *unstated*
  changed the design: the warning now rides two channels, so it degrades to "the human sees it"
  instead of to nothing.

### A guard you have not watched fail is not known to be a guard

- Delete a pack's `comments` block and rerun `empo pack test php`: three phantom findings return.
  Empty the typescript pack's `stringQuotes` and a route whose URL contains `//` is lost. Both were
  run; both guards are real.
- **The raw-NUL trap recurred while `engine/hazards.ts` was being written**, which is the argument
  for having pinned it against the whole tree rather than against the two files it had bitten. That
  module joins a dedupe key the way `build.ts` does, the writing tool put a literal NUL where the
  source said `\u0000`, and it announced itself the way it always does, by `grep` finding nothing at
  all rather than erroring, because grep reads a file holding a NUL as binary. That half is reported
  by the agent that hit it; the end state is checked, and no file under `src/` holds a raw NUL.

  **The second instance is this paragraph.** Writing the sentence above put a raw NUL into
  `docs/14-implementation-notes.md`, in the very backticks naming the escape, and it announced itself
  the same way within the minute: a `grep` for a heading that had just been written returned nothing,
  and so did a `grep -rlP "\x00" docs/`, because the file grep will not search is also the file grep
  will not report. It was repaired by writing the bytes with a tool that does not interpret an escape,
  and confirmed by counting the byte rather than by grepping for it. Two lessons, and the second is
  the one that generalizes past this byte. **The tool that writes a file can transform what you typed,
  so a character whose whole point is that it is invisible has to be verified by counting bytes and
  never by searching for it.** And a tree-wide pin is the only shape that helps here, because both
  instances landed in files no earlier pin had reason to name: the suite walks every `.ts` under
  `src/` (`test/engine/build.test.ts`), which caught nothing this time, since `docs/` is not `src/`.
- **Revert the fix and watch the pin fail, then check the revert really reverted.** One attempt
  missed the top-level `.strictObject(` on its own line, so two of three new pins passed against what
  looked like the old behaviour and proved nothing.
- **A guard that compiles is not a guard that bites.** The exhaustive `kind: never` check was first
  written taking the config object rather than `forge.kind`. A config type is one object type, not a
  union, so the object never narrows and the check would have proved nothing while looking exactly
  like a check. Verified afterwards by adding a fourth kind and watching the compiler reject it. Note
  which domain it is exhaustive over: adding a kind to the `ForgeKind` union did not break the
  factory; adding it to the config enum did.
- The copy-line test was proved by mutation in three directions: stale printed text with the program
  unchanged, a renamed option with the text unchanged, and the ticket flag alone. Three reds, each
  naming the offending flag, and the "has teeth" control still passing.

### Build fixtures and tests that are able to disagree with you

- `fixtures/acme-platform` has one covered flow, one blind flow and one flow no test reaches, because
  a fixture where every flow looks the same cannot prove the blind computation works. Adding a second
  root immediately turned a blind flow into a covered one, exposing the coverage walk crossing a
  process boundary that no design review caught.
- **A fixture whose fields are all the same string cannot fail.** A repository name that happened to
  spell workspace and repo identically at every site would have let a parser returning the last path
  segment twice pass the whole suite. Replacing it with two distinct strings made those tests able to
  fail, and one explicit same-string case now holds that property on purpose.
- **Derive the same answer three ways before a snapshot freezes it.** The typescript snapshot was
  derived by hand, again by an agent told not to run the code, and a third time by the pipeline. A
  snapshot produced by `--update` asserts whatever the code did.
- **A defect that is fixed but not pinned regresses.** Every defect fixed gets a test that fails
  against the old behaviour, written before the session ends.
- **The fixture earning its keep looks exactly like the fixture being wrong.** Widening the php
  `assertionTerms` turned five specs red, because `fixtures/acme-platform`'s deliberately BLIND flow
  was blind only on the strength of `assertTrue(method_exists(...))` not being a term. The tempting
  read is "my good change broke a brittle fixture". The true read is that those five specs are the
  only thing pinning the tool's most important computation, and they fired on the first change that
  could have deleted it. The fix went into the fixture's assertion, never into the term list, and the
  file now carries a comment saying why.
- **A snapshot gate catches only what its corpus contains, so the refusals need fixtures too.** The
  typescript pack's JSX tag rules shipped with nine fixture files pinning what they match and not one
  pinning what they must not, and both defects a review then found were of that shape: a tag rule
  that also read a `.ts` file's strings, and a tag that resolved to a util module sharing a
  component's basename. `empo pack test` was green through both, because a snapshot asserts the
  edges the corpus produces and says nothing about the edges another corpus would have produced. A
  new rule needs a fixture per refusal it claims, and each of those fixtures has to be watched going
  red against the rule without the clause that refuses.
- **Ask what an assertion was protecting before you make it pass.** Six `toContain("bitbucket")`
  assertions went red when the kinds changed; retargeting them to `toContain("mcp")` would have gone
  green while deleting the only thing pinning that a host name reaches the agent, which is the whole
  feature. The fix was to change the fixture. If updating an expected string is the entire fix, be
  suspicious.

### A green suite is not proof

- **`tsc` catches what a green suite passes over**: a typing slip survived 124 passing tests, because
  vitest does not typecheck.
- **A sub-agent's green suite is not proof.** The findings gate arrived passing, with a defect in the
  middle: it deduped against every submitted finding rather than the survivors, so a fabricated
  finding sorting first took a real one down as a "duplicate", inverting the one thing the gate does.
  Nothing failed, because the tests asserted what the code did. Read hardest at the part that decides
  what to throw away.
- **A field the schema does not name is stripped at load, and the fix that reads it dies silently.**
  A sub-agent added `multilineQuotes` to a `pack.json` and to the `CommentSyntax` type, but not to
  `pack.schema.ts`, and `loadPack` returns the zod-parsed data. Zod strips undeclared keys, so the
  field never reached the masker: the masking fix passed its own unit tests, which build the syntax
  object by hand, and did nothing in the real pipeline. It was caught only by reaching into the base
  `comments` in a different test and noticing the shape had no such key. The same strip bit the
  config schema once too: **if a test constructs the object the code will receive, it is not testing
  that the loader produces that object.** Route at least one
  test through `loadPack` or the real parse, and assert the field survives.
- **A mutation that did not apply is not a green result.** The rule above this file already states
  that a pin nobody has watched go red is a comment, and here is the way that rule fails from the
  other end. A pin was nearly dropped as unnecessary because the mutation written to break it left
  the suite green: the patch had matched nothing, because `pack.json` writes one rule per line and
  the edit was written against a multi-line shape. Applied properly the pin bites immediately.
  **Assert the file changed before believing what the suite then says**, exactly as a probe that
  returns no output is not a probe that found nothing.
- **A spec helper decides what the spec can see, and printed output is where that bites.** Three
  defects in one reviewed commit were unreachable by any assertion in the file that covers the
  command, because its `section()` helper stops at the first blank line and collapses runs of
  whitespace: a note's blank-line separator, its indent and every column width were invisible, and
  two of the three lived precisely there. The convention this repo already keeps, that printed text
  is an interface, needs the other half said out loud: **when layout carries meaning, at least one
  test has to read raw lines**, or the helper that makes the other assertions readable is also the
  thing hiding the defect.
- **A sentence that is true on one surface can be false one command over.** A note explaining why
  `empo init`'s brief held rows back reused the string `empo query --orphans` prints for its own
  subtraction. The two do not subtract the same set, so the shared sentence gave, as the reason a
  row was hidden, the property it shared with the rows printed directly above it. Sharing one string
  between two surfaces is right only where the two make the same claim; where they differ, one
  string is not consistency, it is a wrong answer in two places at once.
- **A non-deterministic suite corrupts every agent's signal, not just yours.** Much of this suite
  drives real git on purpose, and vitest's 5s default was being crossed under load from six agents.
  "Tests pass" and "tests fail" were both unreliable. The timeout raise was *proved* by a control run
  on a frozen tree: 1 failure at 20s, 13 failures with 4 timeouts at 5s. The ones that timed out were
  the subprocess-heaviest, including the regression test for the worst bug then open, where a red
  reads as "the fix is broken".
- **You cannot measure determinism against a tree being written to.** Hash it, confirm it holds, then
  measure. A differing test count between two live runs is agents landing, not flakiness. While work
  is landing, any "the suite is green" is a claim about a tree that no longer exists.
- **Run the suite serially before believing a failure.** `--no-file-parallelism` is the tiebreaker.
  Concurrency has both manufactured phantom failures and exposed a real defect here, so reproduce
  serially and then decide: never dismiss, never believe the first red.
- **Green here is not green on the next machine, and the developer's git config is where it bites.**
  Much of this suite drives real git, and git reads the human's configuration before it reads
  anything a test wrote. Four specs were decided that way. The `healthReport` commit-record cases
  ask git whether `.empo/generated` is ignored, so a global `core.excludesFile` carrying that rule
  flips the answer and fails two of them in opposite directions at once; this repository's own
  `.gitignore` holds that very rule, which is what makes an EmPo developer the likely victim. The
  two specs that need a second repository clone it over a local path, which a git hardened after CVE-2022-39253
  refuses outright, and corporate and CI images do set `protocol.file.allow=never`; both then died
  in setup rather than on the behaviour they are about. The fix in both cases is that the throwaway
  repository states what git should answer rather than inheriting it: a `!` rule written into
  `.git/info/exclude`, which outranks an excludes file whichever config level supplied it, and
  `-c protocol.file.allow=always` on the clone alone, the one level that outranks a config file.
  Each is pinned by running the spec against the hostile config, so deleting the defence goes red
  here instead of on somebody else's machine.
- **Reproduce a git-config hazard with `GIT_CONFIG_GLOBAL`, never with `GIT_CONFIG_COUNT`.** The env
  form behaves like `-c` and so outranks a repository's own local config, which the shape it stands
  in for (a setting in the human's global config) does not. Used as the instrument it condemns fixes
  that are correct, which is a false red about a false red. Point `GIT_CONFIG_GLOBAL` at a config
  file written for the run, and know that it replaces the whole global config: a spec needing an
  identity, a credential or an `insteadOf` rewrite loses it for that run.
- **Two git facts no spec can state for itself, so `vitest.config.ts` states them once for every
  worker.** Both were read out of the source rather than met in a red run, and both decide outcomes
  across files that have nothing to do with each other, which is why the answer is central and not a
  flag per helper. A global `core.hooksPath`, which a developer points at a lint runner or a "no WIP
  commits" check, fires that hook inside every throwaway repository the suite creates: measured, 175
  tests across 12 files, reported as `git commit failed` by whichever `commit()` helper got there
  first. And git walks *up* looking for a repository, so a `$TMPDIR` inside a checkout
  (`TMPDIR=$HOME/tmp` with a dotfiles repo at `$HOME`) gives every `mkdtempSync` directory a real
  sha: measured, 3 tests fail outright and several more keep passing while testing something else.
  The hooks override is *appended* to whatever `GIT_CONFIG_COUNT` chain is in the environment, so it
  outranks the global, system and local config and any earlier entry in that chain without taking
  anything else away, and `GIT_CEILING_DIRECTORIES` stops the walk at the temp root while still
  letting git find a repository the suite itself created below it. `test/suite-environment.test.ts`
  is what keeps the config honest, and the two halves are pinned to different strengths, which was
  found by deleting each and watching what went red. The hooks half builds the hostile condition for
  real, a `pre-commit` that refuses, reached through a written `GIT_CONFIG_GLOBAL` exactly as a
  developer's own would be: delete the override and it goes red here, on a machine where nothing is
  wrong. The ceiling half cannot be built that way, because it changes nothing on a machine whose
  temp root is outside every checkout, which is every machine this suite is green on. Deleting it
  therefore went unnoticed by all three original cases, so what is asserted now is the contract
  rather than the effect: the variable reaches the workers and names the temp root the tests build
  under. That is a weaker pin and it is labelled as one in the spec, because the alternative was a
  config line nothing at all would have missed. The four specs whose titles claim "not a git
  checkout" now also assert it themselves, since a wrong green is the failure mode here and only the
  spec can say what it meant.
- **`engines` is a promise about who may install this, and nobody in the room is the one it is made
  to.** The first half of this lesson was that a test helper breaks it first: `package.json`
  declared `"node": ">=20"`, nothing under `src/` needed newer, and a snapshot helper reached for
  `Dirent.parentPath` (20.12.0) and `readdirSync`'s `recursive` (20.1.0). On 20.0 through 20.11, all
  inside the declared range, the first throws `ERR_INVALID_ARG_TYPE` before the test asserts
  anything and the second is ignored as an unknown option and silently counts the top level only.
  The walks were written out by hand, which was the right call and is still in the tree.

  **The second half inverts the first.** The floor was never holdable at
  all: `commander@15` declares `>=22.12.0` and `execa@10` declares `>=22` and calls
  `Set.prototype.union`, so on Node 20 `empo --version` exits 1 on a `TypeError` thrown out of
  `node_modules` before any EmPo code runs, and `vitest` collects zero specs because
  `src/engine/git.ts` imports execa at module scope. Measured on Node 20.19.5, with 22.22.2 and
  24.10.0 both green. Two things to carry. **The care went to the wrong half**: a session spent
  twelve lines avoiding an API that was three minor versions inside the range, while a direct
  dependency was two majors outside it, and nothing looked at the dependency because nothing had to.
  And **a floor is only tested by people who are not in the room**, so it needs a machine: the CI
  matrix runs the supported lines and `test/engines.test.ts` compares the declared floor against
  every runtime dependency's, which is the check that would have caught this the day execa 10
  landed.
  What neither can do is run the floor itself, because `22` in the matrix resolves to the newest 22,
  so 22.12.0 exactly is still asserted rather than exercised.
- **A headline answer that does not change is not evidence that it was right.** This is the sharpest
  lesson the first contact with a codebase larger than the fixtures produced. Two defects were fixed
  there, neither visible from the synthetic fixture, and both had the same shape: a plausible piece
  of data that turned a headline answer into noise, in the direction of false comfort. Read the before and after as one number. Test files scoring as value-asserting went
  from 15 to 393 of 409, and flows owning their own colocated tests went from 46 in a single flow to
  0. Before the fixes `empo query --blind` said "none"; after them it still said "none", and only the
  second "none" was true. Both the defects and the correct behaviour produce the same output, so the
  only way to tell them apart was to compute the denominator. When a fix does not move the number it
  was supposed to move, that is the moment to go and count what the number is drawn from, not the
  moment to conclude the number was already correct. It is also the argument for the
  `flowsConsidered` counts: `empo query --blind` now states how many flows it
  considered, how many a test reaches and how many have one that asserts, so the denominator this
  paragraph had to be computed by hand is printed under the answer.

### Read the words, not only the tests

- **Read rendered output as the agent receiving it, with no other context.** Three defects in the
  generated instructions were found this way and none was reachable by an assertion: text that
  contradicted itself about how many phases a review has, a promise of a field mapping only one host
  gets, and actionable clauses split across printed line breaks. The printed text is an interface.
- **Read command output, not only tests.** Every spec was green while `empo init --proposal` printed
  "2 flows would be written" for flows the human already owned and `--apply` correctly declined to
  write. Nothing was wrong except the sentence, and the sentence is the whole interface for the
  person deciding whether to run `--apply`.
- **Prose that was true when written is harder to catch than prose that was always wrong**, because
  it reads as considered rather than careless. `README.md` described adapters that "degrade rather
  than pretending to have read a pull request" long after those kinds had stopped existing and
  started failing validation instead. It survived three review passes because the sentence is well
  turned. Hunt for that shape, not for wrong sentences.
- **A comment describing what the code should do is not a test.** The staleness check carried a
  comment explaining that `===` "would report staleness on every payload ever written", directly
  above a line that did exactly that.
- **A doc claim is a testable claim** whenever it says "before", "always" or "even when".
  [06-cli](06-cli.md) asserts the machine-owned deny fires before the config is read; that was
  verified by running the hook in a directory with no config at all.
- **A `--json` path is a second output surface** and every branch that prints must know about it.
  `empo check --json --bypass` emitted a valid document followed by plain text and parsed as nothing,
  at exactly the moment a machine reader most needed telling.
- **A generated file's silences are as load-bearing as its contents.** Init cannot detect a bridge,
  so it writes none; left unsaid, a two-language monorepo would report zero cross-language reach,
  which is what a repository with no coupling reports. Init prints the gap.

### Working with sub-agents

- **Give the interface before the file exists.** Agents coding against field names written into a
  shared contract meet exactly; an agent told to "use the health report" invents a shape.
- **A shared note is a force multiplier in both directions.** Every good decision in it reached six
  agents within minutes. So did a real codebase's name in its config example, where no name outside
  the fixtures belongs, and four agents copied it into five files inside an hour. It is the single
  worst place to be casual.
- **Ask what they declined to fix or test, then go and reproduce it.** The most valuable thing in a
  report has repeatedly been the thing an agent chose not to pin: the settings merge that cannot tell
  its own entry from a human's, and the glob branch running on picomatch defaults so `config/**`
  waved `config/.env` through while the bare directory guarded both. Both were deliberate
  non-decisions, correctly made, and both only surfaced because the report asked.
- **An agent reasoning from a behaviour you already fixed sounds exactly like an agent reporting a
  bug.** Two independent agents once predicted that `--orphans` would call every Laravel view and
  policy dead code. That was true before the `resolvedBy: "framework"` filter and is false now, and
  both had read the code rather than the changelog. A third reported that a target's `flows.json`
  declared 16 flows when the file on disk was `{"flows": {}}`, 34 bytes, untouched. Every one of
  those claims cost one command to check. Check the cheap ones first: a claim about current state is
  verifiable in seconds, and a claim about reasoning is not.
- **Do not conclude from a check run at the wrong moment.** Three separate race-window reads happened
  in one session, each reported honestly and each wrong. An empty grep in the gap between a message
  and a write is not evidence of absence. Re-read before concluding when several agents are writing.
- **Enumerate what nobody owns.** Splitting work by file left this doc and `README.md` unassigned;
  both were found by luck at the end. A file nobody owns is reviewed by whoever happens to look.
- **Two files agreeing about one rule is a rule with no owner.** The payload gate accepted either
  branch spelling and the adapter then diffed the raw name, breaking every review of a branch not
  checked out locally. The fix was to have the gate hand back which spelling resolved, explicitly not
  to repeat the fallback in the second file.
- Delegating bulk file writing keeps the main context for judgement, and works when each agent is
  given exact facts and told to report rather than fix what it finds elsewhere. Judge what comes back
  on the merits: several defects came back from agents, and at least one was best answered by a
  different fix than the one proposed.
