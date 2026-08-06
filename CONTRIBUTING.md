# Contributing to EmPo

EmPo is a language-agnostic impact and review toolkit that keeps an AI coding agent honest about a
codebase: it builds a deterministic dependency graph, then gates agent-written findings against real
source. A contribution here is usually one of four things: a new or improved language pack, an
engine fix, a documentation correction, or an adapter for a host EmPo cannot yet speak to.

## Getting set up

```bash
git clone https://github.com/W1-PopelierE/EmPo.git
cd empo
npm install
npm test
```

`npm test` needs no build first. Tests import `src/` directly and nothing under `test/` executes a
built artifact. `test/global-setup.ts` indexes `fixtures/acme-platform` once before any spec,
because `.empo/generated/` is gitignored and so absent in a fresh clone. Do not add a defensive
delete-and-reindex to a new spec; the central build exists so nobody has to remember.

To get the CLI on your PATH while you work, `npm run install:local` builds the standalone binary and
installs it at `~/.local/bin/empo`, a fixed path that no Node version switch moves. Do not put a
global `npm link` beside it: a global npm prefix is per interpreter, so running both means whichever
sorts earlier on PATH wins with nothing said either way. A stale build means stale hooks, so
reinstall after changing anything under `src/` that a hook reaches.

## Read the docs first

`docs/` is the source of truth for this repository, not the code. Before any non-trivial change,
read `docs/00-overview.md`, `docs/01-architecture.md` and `docs/04-language-packs.md`. The language
pack document is the most important contract in the project: it is what makes adding a language a
data file rather than a parser. `docs/05-graph-model.md` and `docs/14-implementation-notes.md` are
the next two worth your time, and `README.md` maps every document.

When a decision changes, update the doc in the same commit, so code and docs never diverge.

## How to propose a change

Open an issue first for anything non-trivial, so the design can be settled before you write it. Then
branch, commit, and open a pull request against `main`. Commit messages are one-line prose. Let the
pre-commit hooks run, never `--no-verify`.

## Commands

```bash
npm test                    # vitest run
npm run test:watch
npm run typecheck           # tsc --noEmit (vitest does not typecheck)
npm run check               # biome check .
npm run build               # tsup, producing dist/empo.js
npm run build:binary        # Node SEA, producing dist-binary/empo (carries its own interpreter)

npx vitest run test/engine/graph.test.ts               # one file
npx vitest run test/commands/index.test.ts -t "<name>" # one test, by title substring
npx vitest run --no-file-parallelism                   # serial: the tiebreaker for a suspect failure
```

## Verification

**Verification is all four, every time, and none substitutes for another:**
`npx vitest run --no-file-parallelism`, `npx tsc --noEmit`, `npx biome check .`, and the commands
run against the **built bundle** (`node dist/empo.js ...`), which resolves packs and discipline
markdown differently from `src`: `engine/pack-loader.ts` and `discipline/load.ts` each probe two
roots, one for source and one for the published layout.

There is a **third** resolution path and those four do not reach it either. The standalone binary
carries its pack JSON, its discipline markdown and its version string compiled in through
`src/embedded.ts`, and consults no disk root at all where those are populated. A change to a pack or
to `discipline/` can pass all four, pass against `dist/empo.js`, and still be absent from the
binary. Build it and run the command there when you have touched what it embeds:
`npm run build:binary`, then `dist-binary/empo ...`. The two builds are different artifacts, and the
hooks execute the second.

## Architecture

Four layers with different owners (`docs/01-architecture.md`):

1. **Mechanical**: `src/engine/` and `src/commands/`. Deterministic, no LLM, no network, seconds.
   Produces `.empo/generated/graph.json`.
2. **Semantic**: `.empo/flows.json` and `.empo/spines/*.json`. An agent proposes, a human owns.
3. **Discipline**: `src/discipline/*.md`, shipped and project-independent. The review workflow, the
   verification funnel, the forbidden phrasings.
4. **Adapters**: config plus `src/packs/` and `src/adapters/`. What makes EmPo run in someone else's
   repo at all.

The graph models **three coupling levels**: intra-language import edges; inter-language *string*
edges, where a route path the backend produces meets the same path the frontend consumes (the
monorepo feature, invisible to every import parser); and flows, which are end-user journeys that may
cross roots.

### The indexing pipeline

`empo index` is the only entry point that writes the graph.

```
commands/index.ts  indexCommand
  engine/config.ts       loadConfig            .empo/config.json or empo.config.json
  engine/graph.ts        buildGraph            roots sorted first
    per root:
      engine/pack-loader.ts  loadPack          re-reads and re-parses; buildGraph caches per lang
      engine/build.ts        buildRoot
        engine/scanner.ts      scanRoot        -> {root, file, relPath, source}
        engine/mask.ts         maskComments    runs BEFORE any pack rule
        engine/extractor.ts    extractFile     regexes compiled once per pack
        engine/resolver.ts     resolveEdges    captures -> node ids
        dedupeNodes / dedupeEdges
    across roots:
      dedupeNodes again, engine/bridger.ts bridgeRoots (the level-2 edges),
      engine/flows.ts assignFlows, engine/git.ts gitInfo,
      computeFanin, engine/coverage.ts computeCoverage
  engine/graph.ts        serializeGraph
  writeFileSync -> .empo/generated/graph.json + packs.lock.json   (commands/index.ts, the only write)
```

`engine/graph.ts` is the only module that constructs, reads or serializes the `Graph` shape, and it
writes nothing. `engine/detect.ts` and `engine/scaffold.ts` are not in this path at all: they run
from `empo init`, *before* a config exists, off each pack's `match` block alone.

### Non-obvious invariants

- **Determinism is a hard requirement.** `graph.json` must be byte-identical for identical input on
  any machine, and `empo index --check` compares bytes rather than counts. Every sort goes through
  `compareStrings` in `engine/order.ts`; `localeCompare` is banned, because it disagrees with itself
  across locales and ICU builds. `test/engine/determinism.test.ts` asserts each rule separately, so
  a failure names which one broke.
- **Two path forms travel side by side.** `file` is repo-relative (nodes, evidence, flows);
  `relPath` is root-relative (pack `kindRules`, `tests.paths`). Node ids are repo-relative, never
  root-relative, or two roots both owning `src/index.ts` would collide. Mixing the two forms breaks
  string comparisons silently; `engine/scanner.ts` documents it.
- **`engine/git.ts` is the only module that spawns a subprocess**
  (`adapters/tracker/github-issues.ts` is the single other `execa` importer, and it routes through
  the same `run`), so there is exactly one file to audit for what this tool executes.
- **Nothing under `engine/` calls `process.exit`, and nothing under `engine/` makes an LLM call.** A
  command returns its exit code by throwing a typed `EmpoError` from `src/errors.ts`, caught in
  `src/empo.ts`: 1 = a mechanical gate failed (`check`, `verify`, `index --check`, `pack test`), 2 =
  usage or config error, 3 = environment error. `review` and `init --proposal` deliberately never
  return 1: they report, they do not gate.
- **A `--json` path is a second output surface**, and every branch that prints must know about it.
  `doctor` and `check` throw *after* printing on purpose, so stdout ends on exactly one complete
  document.
- **Dedupe keys join on a NUL byte, written in source as a `\u0000` escape and never typed raw.**
  Paths and anchors contain spaces, so a space join would collapse distinct pairs. The escape is
  also what keeps the source greppable: `grep` treats a file holding a raw NUL as binary and reports
  no match rather than an error, so a raw one hides itself.
- **Coverage does not travel across a bridge** between roots. A mobile test is not evidence about
  the API. Inside one root it travels normally.
- **A flow never contains a test node.** `reachableFrom` seeds its set with the start node, so a
  test inside a flow would make that flow `assertsValue` by construction and it could never go
  blind.
- The scanner matches globs with `dot: false` (a file the graph never holds cannot be a node); the
  commit gate matches with `dot: true` (a diff carries `.env`, and a gate may not fail open). The
  inversion is deliberate.
- **Staleness is never silently zero.** `commitsAhead` and `staleness` return `null` on unknown, so
  a hook outside a git checkout stays quiet instead of crying wolf.
- **An import alias is config, and `empo index` reads nothing but config.** A non-relative specifier
  resolves through the root's `aliases` (`roots[].aliases`, spelled like a tsconfig `paths`), and
  `engine/aliases.ts` seeds that field from the toolchain's own config at `empo init` time only. The
  build never opens a tsconfig, which is what keeps the graph a function of config plus scanned
  files. Where the toolchain declares an alias map, the pack says which file and which field
  (`aliasSources`), so no language-specific string enters `engine/`.

### Ownership

`.empo/generated/` is **machine-owned**: only `empo index` writes it. Never hand-edit it and never
patch it to make an answer come out the way you expected. An edited graph produces an impact answer
that looks generated and is invented, which is the single failure this tool exists to prevent. If an
answer is wrong, fix the config or the pack and reindex. Everything else in `.empo/` is human-owned;
`empo init` reports an existing file as `kept` and leaves it byte for byte, and there is no
`--force`.

## The two-phase shape

The CLI makes no model call anywhere, so every agent-assisted command splits in two with the agent
in the middle: **a brief, an agent, a gate.** `empo review` prints facts plus the shipped
discipline, then `--findings <path>` resolves every citation against real source and prints only the
survivors. `empo init` prints a map brief, then `--proposal <path>` gates it and `--apply` writes
what survived.

The same asymmetry runs through both gates: a citation whose anchor **moved** is corrected and
survives, because the quoted source is there and only the coordinate slipped; one whose anchor is
**nowhere** is dropped, because the claim stands on text that does not exist. In the findings gate
that drops one finding. In the proposal gate one bad citation drops the **whole spine**, because a
findings list is read one item at a time and a spine is read as a map.

Two details in `discipline/findings.ts` are load-bearing and easy to break: findings dedupe against
**survivors only**, never against everything submitted, or a fabricated finding sorting first takes
a real one down as a "duplicate"; and the citation check runs **before** the phrasing lint, so a
finding that is both hedged and fabricated is reported as fabricated, which is the more actionable
answer.

## Adapters

`ForgeAdapter` and `TrackerAdapter` declare a `capabilities` set rather than letting callers guess,
so a review can say "CI result unavailable" instead of inventing a green pipeline. Both `create.ts`
files are pure degradation paths: they never throw, never fetch, and return a `note` that travels
into the report rather than being logged. Each ends in an `unbuildable*(kind: never, ...)`
exhaustiveness proof, and each takes `forge.kind` rather than the config object, because only the
discriminant narrows. Adding a kind to the `ForgeKind` union alone will not break the factory;
adding it to the config enum will.

The `mcp` forge and tracker kinds are **one kind per side covering every host EmPo cannot speak to**
(Bitbucket, GitLab, Jira, Asana, Linear), not one adapter each. EmPo makes no model call and cannot
reach an MCP server, so the flow inverts: the agent fetches with its own connector and writes JSON,
and `adapters/host-input.ts` checks that payload against real git before any of it is believed. A
hallucinated pull request is well formed and names branches this repository does not have.
`adapters.*.host` is free text and **the engine never branches on it**.

Two things to preserve there. The diff is **never** taken from the payload: `forge/mcp.ts` computes
it locally with `diffRange`, so the one artifact a review reads line by line is one no model
touched. And absence is distinguished from emptiness: a payload with no `comments` key means "not
fetched" while `comments: []` means "fetched, there are none", and the report must be able to say
which.

## Language packs

A pack is **declarative JSON** at `src/packs/<name>/pack.json` plus a fixture corpus. There is no
code in a pack, and `src/schema/pack.schema.ts` validates it, compiling every declared regex and
checking capture-group arity against what each `resolve` strategy reads. Extraction is
regex-over-source with no AST parser dependency; tree-sitter was evaluated, measured and declined,
and `docs/14-implementation-notes.md` records both the numbers and the one condition that would
reopen it. Adding a language is a data file, not a parser, and **the engine must contain no
language-specific logic**.

Workflow for a new or edited pack: **corpus first, snapshot second, rules third.**
`empo pack test <name>` runs the real `buildRoot` over `src/packs/<name>/fixtures/src` and diffs the
result against `fixtures/expected.json`, exiting 1 and naming every difference. `--update` rewrites
the snapshot; run it only after reading every line the failure printed, because a snapshot produced
by `--update` asserts whatever the code did.

**A field the pack schema does not declare is stripped at load.** Zod drops undeclared keys and
`loadPack` returns the parsed data, so a new `pack.json` field not added to `pack.schema.ts` never
reaches the engine, while unit tests that build the object by hand still pass. Route at least one
test through the real `loadPack` and assert the field survives.

`aliasSources` is the one pack block **`empo index` never reads**: it says where this language's
toolchain keeps its import aliases, and only `empo init` opens it, to seed config `roots[].aliases`.
The `module` escape hatch is declared in the pack contract and **no engine code loads it**; a pack
naming one is accepted with its hatch silently dropped. A pack version and the CLI version are
unrelated numbers, and pack bumping is pinned by `test/packs/versions.test.ts`.

## Testing discipline

- **No test may reference a real codebase.** Every example is the fictional `acme-platform`. Run the
  `docs/11-security-boundaries.md` checklist over what the repo *already holds*, not only over what
  you are adding, and grep the whole tree.
- Pack tests are snapshot tests against synthetic fixtures. Engine tests use tiny inline inputs.
  Integration tests run whole commands against `fixtures/acme-platform`. There is no shared test
  helper; each spec repeats the `mkdtempSync` + `cpSync` fixture-copy boilerplate itself.
- **The machine's git is an input, and `vitest.config.ts` takes two votes away from it.** A global
  `core.hooksPath` would fire your own hooks in every throwaway repository, and a `$TMPDIR` inside a
  checkout would give every `mkdtempSync` directory a real sha, so `gitEnvironment` there appends a
  `core.hooksPath` override to the `GIT_CONFIG_COUNT` chain and sets `GIT_CEILING_DIRECTORIES`.
  `test/suite-environment.test.ts` is the pin. Reproduce a git-config hazard with
  `GIT_CONFIG_GLOBAL` and never with `GIT_CONFIG_COUNT`: the env form behaves like `-c` and outranks
  the local config that the shape it stands in for does not.
- **Nothing under `test/` may use a Node API newer than `engines` allows.** A Node API is usable
  here only once `engines` admits every version that lacks it, because the floor is a promise to
  whoever installs this and not a detail of the suite. The two APIs this rule was written about,
  `Dirent.parentPath` and `readdirSync`'s `recursive`, both failed silently rather than loudly below
  their version, which is why the rule is a ban rather than a thing to test for.
- **A defect that is fixed but not pinned regresses.** Every fix gets a test that fails against the
  old behaviour. Revert the fix and watch the pin go red, then check that the revert really
  reverted.
- **Ask what an assertion was protecting before you make it pass.** `fixtures/acme-platform` has one
  covered flow, one blind flow and one flow no test reaches, on purpose. When widening the php
  pack's `assertionTerms` turned five specs red, the fix belonged in the fixture's assertion and
  never in the term list, and that fixture now carries a comment saying why.
- **A green suite is not proof.** `tsc` catches what vitest passes over, and a test can assert what
  the code does rather than what it should.
- **Run the suite serially before believing a failure.** Concurrency here has both manufactured
  phantom failures and exposed a real defect, so reproduce with `--no-file-parallelism` and then
  decide. Never dismiss a red, never trust the first green.
- **Read rendered output as the agent receiving it, with no other context.** Several defects in the
  generated instructions were unreachable by any assertion. The printed text is an interface.

## CI and the version number

`.github/workflows/ci.yml` is the only workflow. `verify` runs the four verifications plus the
built-bundle commands on Node 22 and Node 24, on every pull request and every push to main. `binary`
runs beside it, building the standalone binary and running commands against it, because the
compiled-in assets are a third resolution path that neither `src` nor `dist` exercises. `release`
runs only after those are green on a push to main, and it moves the version: `npm version`, a
`Release vX.Y.Z [skip ci]` commit, an annotated tag, and a GitHub Release. `binaries` then builds
the binary per platform and attaches each to that release. Nothing is published to npm.

- **Never hand-edit `version` in `package.json`.** A merge to main bumps patch. Label a pull request
  `bump:minor` or `bump:major` to say otherwise, `bump:skip` to cut no version at all. The label is
  the signal because commit messages here are one-line prose with no conventional-commit prefix to
  read, and that convention is not up for trade.
- **The CLI version reaches no artifact.** `graph.json` records the pack versions and the graph
  schema, never this one, so a bump cannot make a graph stale or move a byte of `graph.json`. Keep
  it that way: a release number in the graph would make every release a reindex.
- **The Node floor is `>=22.12.0` and a dependency decides it, not a preference.** `commander@15`
  needs 22.12.0 and `execa@10` needs 22. `test/engines.test.ts` compares the declared floor against
  every runtime dependency's and fails when a bump moves the real one, so raise `engines` and the CI
  matrix together, in the change that raises the dependency.

## Conventions

- ESM, named exports, no default exports. `verbatimModuleSyntax` is on, so type-only imports must
  use `import type`.
- Biome: 2-space indent, **line width 100**, double quotes, `organizeImports` on. `fixtures`,
  `src/packs/*/fixtures`, `examples`, `.claude` and `.empo` are excluded, because a fixture is data
  that must stay byte for byte as written and reordering its imports moves the very line numbers the
  expected snapshot pins.
- `tsconfig.json` is `strict` with `noUncheckedIndexedAccess`, includes `test` and the config files,
  and excludes `src/packs/*/fixtures`.
- The engine is pure where it can be. Side effects (reading files, writing `graph.json`) live at the
  edges, in `scanner` and in the commands.
- The command is `empo index`, but `index.ts` is a loaded module name in JS: `commands/index.ts`
  exports a named `indexCommand`, and nothing relies on default index resolution for it.
- **No em-dashes in written output.** Commit messages are one-liners.

## This repo runs EmPo on itself

`.empo/config.json` indexes `.` with the typescript pack, and `.empo/flows.json` defines one flow
per command surface. `.claude/settings.json` wires three `empo hook` entries (SessionStart,
PreToolUse on `Edit|Write`, PreToolUse on `Bash`). The `.claude/skills/empo-*` files and the
`AGENTS.md` managed block are **generated by `empo update`**: edit `.empo/config.json` and rerun,
never the generated files.

- The hooks call `empo` on PATH and **fail open** where it is not installed, deliberately.
  `empo check` in CI is the gate that has to hold. A hook never exits non-zero, not even to deny:
  a denial is structured JSON on stdout with exit 0, because exit 2 discards stdout.
- `.empo/conventions.md` is the false-positive register a review reads before flagging anything.
- Some files under `src/` belong to no flow on purpose: the machinery every journey passes through
  (`empo.ts`, `program.ts`, `errors.ts`, `engine/config.ts`, `engine/git.ts`, `engine/order.ts`,
  `schema/types.ts`, `embedded.ts`), and the build tooling, which is neither a journey nor on the
  path of one. `empo doctor` prints the count, so drift is visible on the next run rather than
  invisible until somebody reads `flows.json` against `src/` by hand.
- **A new module under `src/engine/` needs its `flows.json` line in the same change**, or the
  repository stops dogfooding its own answer.

Prefer `empo query` over grepping for consumers and guessing: that is what the graph is for. Its
answer is a **floor and not a ceiling**, because reflection, dynamic dispatch and configuration add
reach no static graph can see, so say that out loud when reporting a blast radius. When an answer
looks wrong, run `empo doctor` first: a stale graph answers about code that has moved.
