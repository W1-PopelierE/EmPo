# 04. Language packs

This is the most important technical document in EmPo. The language pack is the abstraction that
makes one graph builder work across PHP, TypeScript, and anything added later. Get this interface
right and a new language is a data file. Get it wrong and every language leaks its assumptions
into the engine.

## What a pack is

A pack is **declarative and nothing else**: a JSON document of extraction rules, with no
JavaScript escape hatch (see [9](#9-there-is-no-escape-hatch)). The engine loads the pack, runs its
rules over the pack's files, and emits normalized nodes and edges into the shared graph. The engine
contains no language-specific logic. All of it lives in packs.

Extraction is **regex rules over source** and not an AST parse: imports, inline FQCNs, class-name
strings, template references, observer registrations, the class a class extends. That approach
generalizes cleanly across languages, which an AST parser does not, since every language would bring
its own.
Regex-over-source is imperfect (it
cannot follow a class name assembled at runtime) but it is fast, language-portable, needs no
per-language toolchain, and its blind spots are known and documented rather than hidden. EmPo
treats the flow list as a floor, not a ceiling (see [00-overview](00-overview.md)), which is
exactly the honesty this tradeoff requires.

## The pack contract

```jsonc
{
  "name": "php",
  "version": "1.0.0",

  // 1. which files this pack owns
  "match": {
    "extensions": [".php"],
    "manifest": ["composer.json"]          // presence hints the pack is relevant
  },

  // 2. how to identify a node (a unit of code) and its stable id
  "node": {
    "id": {
      // a PHP file is one class; id = its fully-qualified class name
      "strategy": "fqcn",
      "namespacePattern": "^[ \\t]*namespace\\s+([A-Za-z0-9_\\\\]+)\\s*;",
      "namePattern": "^[ \\t]*(?:class|interface|trait|enum)\\s+([A-Za-z0-9_]+)",
      "fallback": "path",                    // no class in the file? id is its repo-relative path
      "indexNames": ["index"]                // module resolution: a basename that stands for its dir
    },
    "kindRules": [
      // resolvedBy:  the framework reaches this kind by name, so a fan-in of zero is no evidence
      // arrivedBy:   somebody outside the code arrives here, so a journey starts at it
      // maskStrings: read the file with string contents blanked before contentPattern runs, for a
      //              pattern that describes code; php declares it nowhere, the typescript pack's
      //              React rule does. Rejected at load on a rule carrying no contentPattern
      { "kind": "route-file",  "pathGlob": "**/routes/*.php",
        "resolvedBy": "framework", "arrivedBy": "user" },  // both, and that is not a conflict
      { "kind": "view",        "pathGlob": "**/resources/views/**", "resolvedBy": "framework" },
      { "kind": "model",       "pathGlob": "**/Models/**" },
      { "kind": "job",         "contentPattern": "implements\\s+ShouldQueue" },
      { "kind": "class" }                    // default
    ]
  },

  // 3. how this language writes comments, so they can be blanked before any rule runs
  "comments": {
    "line":  ["//"],
    "block": [ ["/*", "*/"] ],
    "stringQuotes": ["'", "\""],           // only so a // inside a string starts no comment
    "stringEscape": "\\"
  },

  // 4. intra-language edges (level 1)
  //    a rule may also carry "pathGlob" (where it is allowed to run), "targetKinds" (what kinds a
  //    name may resolve to) and "maskStrings" (read the file with string contents blanked); the
  //    typescript pack's two JSX rules declare all three and php's rules none, and this family is
  //    why the last one is per rule: php's template family also holds @livewire('cart'), whose
  //    component name lives inside the quotes that flag would blank
  "edges": {
    "import":  [ { "pattern": "^[ \\t]*use\\s+([A-Za-z0-9_\\\\]+)(?:\\s+as\\s+\\w+)?\\s*;", "resolve": "fqcn" } ],
    "fqcn":    [ { "pattern": "\\\\(Acme\\\\[A-Za-z0-9_\\\\]+)::", "resolve": "fqcn" } ],
    "string":  [ { "pattern": "['\"](Acme\\\\[A-Za-z0-9_\\\\]+)['\"]", "resolve": "fqcn-string" } ],
    "template":[ { "pattern": "<x-([a-z0-9][A-Za-z0-9._-]*)", "resolve": "short-name",
                   "normalize": ["last-dot-segment", "pascal-case"] } ],
    "hook":    [ { "pattern": "([A-Za-z0-9_]+)::observe\\(([A-Za-z0-9_]+)::class", "resolve": "observer" } ],
    "inherit": [ { "pattern": "^[ \\t]*(?:final\\s+|abstract\\s+|readonly\\s+)*class\\s+[A-Za-z0-9_]+\\s+extends\\s+([A-Za-z0-9_]+)\\s*(?:implements\\b|\\{|$)",
                   "resolve": "short-name" },
                 { "pattern": "^[ \\t]*(?:final\\s+|abstract\\s+|readonly\\s+)*class\\s+[A-Za-z0-9_]+\\s+extends\\s+\\\\((?:[A-Za-z0-9_]+\\\\)*[A-Za-z0-9_]+)",
                   "resolve": "fqcn" } ]
  },

  // 4b. optional: how this language spells a declaration, first group the name declared. Read by
  //     the two name-resolving strategies above and by nothing else, so a tag naming something the
  //     rendering file declares itself is refused instead of resolved against some other file of
  //     that basename (section 4). Shown as the typescript pack declares it; php declares none
  "declares": [
    "^[ \\t]*(?:export[ \\t]+)?(?:default[ \\t]+)?(?:async[ \\t]+)?function[ \\t*]+([A-Za-z_$][A-Za-z0-9_$]*)"
  ],

  // 4c. optional: where this language's package manager writes a package's own name and what it
  //     depends on, so a name imported from a package can be told from a name that lives here. Read
  //     by the same two name-resolving strategies and by nothing else (section 4). Shown as the
  //     typescript pack declares it; php declares none
  "packages": {
    "file": "package.json",                  // manifest basename, matched anywhere under the repo
    "name": "name",                          // field holding this package's own name
    "dependencies": ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
  },

  // 4d. optional: where this framework keeps its templates. Read by the "view" resolve strategy and
  //     by nothing else, and REQUIRED by a pack that names it, since a view name is resolved as a
  //     path below one of these roots rather than as a name in the index (section 4)
  "views": {
    "roots": ["resources/views"],            // matched anywhere in a repo-relative path
    "extensions": [".blade.php", ".php"]     // first one a template's name ends in wins
  },

  // 5. cross-language symbol tables (level 2)
  "produces": [
    { "symbol": "http-route",
      "pattern": "Route::(get|post|put|patch|delete)\\(\\s*['\"]([^'\"]+)['\"]",
      "map": { "method": 1, "path": 2 },      // part name -> capture group
      "key": "{method} {path}",               // how the parts become one key
      "normalize": { "method": ["upper"], "path": ["strip-leading-slash"] },
      // optional: a scope declared in 5b contributes to one part of this key
      "scopedBy": { "name": "route-prefix", "part": "path", "join": "/" } }
  ],
  "consumes": [
    { "symbol": "http-route",
      "pattern": "\\$this->(get|post|put|patch|delete)\\(\\s*['\"]([^'\"]+)['\"]",
      "map": { "method": 1, "path": 2 },
      "key": "{method} {path}",
      "normalize": { "method": ["upper"], "path": ["strip-leading-slash"] } }
  ],

  // 5c. optional: symbol kinds this pack writes both halves of, joined inside one root with no
  //     bridge in config. Refused at load unless this pack both produces and consumes the kind
  "joins": ["scheduled-command"],

  // 5b. optional: what encloses a symbol and contributes to one of its parts. A rule above names one
  //     with "scopedBy": { "name": "route-prefix", "part": "path", "join": "/" }; php declares the
  //     only such block that ships
  "scopes": [
    // the group form: the prefix holds for everything written inside the braces it opens
    { "name": "route-prefix", "pattern": "Route::prefix\\(\\s*['\"]([^'\"]+)['\"]",
      "value": 1, "extent": "balanced", "open": "{", "close": "}" },
    // the provider form: the prefix holds for everything the file it names produces. The run
    // between the two calls is tempered against crossing `Route::`, because an untempered
    // `[\s\S]*?` reaches past the construct that opened it and adopts the next one's argument;
    // that was a real defect, and the shipped pack bounds every such run (see "What the route
    // rules are worth, measured")
    { "name": "route-prefix",
      "pattern": "Route::prefix\\(\\s*['\"]([^'\"]+)['\"](?:(?!Route::)[\\s\\S])*?group\\(\\s*base_path\\(\\s*['\"]([^'\"]+)['\"]",
      "value": 1, "extent": "file", "file": 2 }
  ],

  // 6. how tests look, so the engine can compute coverage
  "tests": {
    "paths": ["tests/"],
    "assertionTerms": ["assertEquals", "assertSame", "->toBe(", "assertTrue(", "assertDatabaseHas("],
    "assertionExcludes": ["assertTrue(method_exists("]  // the liveness spelling of a term above
  },

  // 7. optional: transaction hazards. A pack that omits this block makes no claim at all
  "hazards": {
    "transactions": [
      // the closure form: braces to balance, so the pattern must require the `function` keyword
      { "pattern": "DB::transaction\\(\\s*function\\b",
        "extent": "balanced", "open": "{", "close": "}" },
      // the arrow form opens no block, so it balances its parens instead
      { "pattern": "DB::transaction(?=\\(\\s*fn\\b)",
        "extent": "balanced", "open": "(", "close": ")" },
      { "pattern": "DB::beginTransaction\\(", "extent": "span", "endPattern": "DB::commit\\(" }
    ],
    // the same two extent forms, walked by the same code, but a dispatch in a loop is a fact and
    // never a hazard: these land in graph.fanout, not in graph.hazards
    "loops": [
      // a "{" must follow: an extent that opens on a loop with no block runs to the first unrelated
      // brace, or to the end of the file, and invents everything under it. And it is a lookahead,
      // because balancedEnd starts at the END of the match: a pattern that eats the body's own
      // brace steps past it and sends the walk to the next unrelated block instead
      { "pattern": "(?<![A-Za-z0-9_$])(?:foreach|while)\\s*\\([^{;]*\\)\\s*(?=\\{)",
        "extent": "balanced", "open": "{", "close": "}" },
      // `for` apart: its header holds semicolons, so its bound is the line instead
      { "pattern": "(?<![A-Za-z0-9_$])for\\s*\\([^{\\n]*\\)\\s*(?=\\{)",
        "extent": "balanced", "open": "{", "close": "}" },
      { "pattern": "(?:->|::)\\s*(?:each|eachById|map|chunk|chunkById|chunkMap)\\(\\s*(?:[0-9]+\\s*,\\s*)?(?:static\\s+)?function\\b",
        "extent": "balanced", "open": "{", "close": "}" },
      // the arrow callback opens no block, so it balances its parens, as the arrow transaction does
      { "pattern": "(?:->|::)\\s*(?:each|eachById|map|chunk|chunkById|chunkMap)(?=\\(\\s*(?:[0-9]+\\s*,\\s*)?(?:static\\s+)?fn\\b)",
        "extent": "balanced", "open": "(", "close": ")" }
    ],
    // the third extent family, and the only one whose openers name a KIND of error rather than a
    // construct: a catch of something the ecosystem calls temporary. Same "{" lookahead, same reason
    "transient": [
      { "pattern": "(?<![A-Za-z0-9_$])catch\\s*\\([^)]*(?:RateLimit|Throttl|TooManyRequests|Timeout|Transient|Temporar)[^)]*\\)\\s*(?=\\{)",
        "extent": "balanced", "open": "{", "close": "}" }
    ],
    "dispatches": [ { "pattern": "([A-Za-z0-9_\\\\]+)::dispatch\\(", "job": 1 } ],
    // a site family, not an extent: what it means depends entirely on the catch it sits in
    "permanentFailures": [ { "pattern": "(\\$[A-Za-z0-9_]+->fail)\\s*\\(", "job": 1 } ],
    "deferAtSite": ["->afterCommit\\("],           // this one dispatch waits for the commit
    "deferAtDeclaration": ["\\$afterCommit\\s*=\\s*true"]  // every dispatch of that job waits
  },

  // 8. optional: where this toolchain writes its import aliases, so empo init can seed config
  //    (shown as the typescript pack declares it; php's imports carry no alias and it declares none)
  "aliasSources": [
    { "file": "tsconfig.json",               // relative to the root's directory
      "paths": "compilerOptions.paths",      // dotted field path to the map
      "base": "compilerOptions.baseUrl",     // dotted field path; what targets are relative to
      "extends": "extends" }                 // dotted field path; a relative spelling is followed
  ]
}
```

### 1. `match`: file ownership

Extensions and manifest files decide which pack owns which files. In a monorepo the root's `lang`
in config already scopes this, but `match` lets `empo init` auto-detect languages before any
config exists.

**A pack owns every dialect of the language its manifest roots**, and this is the same rule
`assertionTerms` states for test dialects below. The typescript pack matched `.ts`, `.tsx` and `.vue`
while `match.manifest` named `package.json`: it was rooted by a JavaScript project and then read no
JavaScript. In a repository whose browser-side behaviour layer is written in plain JavaScript, that
left twelve `.js` files out of the graph and those twelve were the whole of that layer. Out of the
graph is the damaging half, worse than in
it with no edges: a query about a file the graph never held answers the same way it answers a typo,
so nothing printed says a whole layer is missing. The list now runs `.ts`, `.tsx`, `.vue`, `.js`,
`.jsx`, `.mjs`, `.cjs`. One consequence at the other end: a repository holding only JavaScript now
detects as `typescript`, which is the honest answer for a pack rooted by `package.json`.

**Declared order decides which file a specifier resolves to**, because `module-path` tries the
extensions in the order the pack writes them (section 4). `.ts` therefore sits ahead of `.js`: a
repository mid-migration holds `money.ts` beside a leftover `money.js` and writes `./money`, and the
`.ts` file is the one its build compiles. Real toolchains disagree here, tsc trying `.ts` first under
`allowJs` and vite's default resolve list putting `.js` first, so this is a decision rather than a
fact and it is pinned in `test/packs/typescript.test.ts` against the shipped pack, not left to
whoever next edits the list.

Adding an extension is two pack-data lines and not one: `tests.paths` needs a glob per new dialect
(section 6), or a test file written in it scores as production code, which is the direction that
invents coverage. It counts as reached by whatever flow holds it and asserts nothing for that flow.

### 2. `node`: identity

Every language needs a stable id for a unit of code so edges can point at it. The `strategy`
abstracts what "a unit" means:

- `fqcn`: one file is one class, id is the fully-qualified name (PHP, Java, C#).
- `module-path`: id is the repo-relative file path (Go, Python where a file is a module of many
  exports, and anything else a file-level answer suits).
- `symbol`: id is `path#exportName`, for languages where a file is a module of many exports and a
  file-level answer is too coarse to act on. The shipped typescript pack declares it.

The strategy list is engine-side and closed here too, and all three are built. `symbol` is the only
one that needs a second key, **`symbolPattern`**, a regex over the file's masked source whose group 1
is the exported name; a pack declaring `symbol` without it is refused by `compilePack` in
`engine/extractor.ts`. That refusal is narrow on purpose. The other two strategies derive their ids
from what the engine already reads, a path for `module-path` and one class declaration for `fqcn`,
and `symbol` is the one that cannot: it has named a granularity and handed the engine no way to
reach it, and falling back to the file-level node the other two produce would answer every later
question about that root with ids the pack did not ask for.

The refusal is raised when the pack is compiled, which happens once and before a single file is
read, and it names the pack that asked. That matters for the two cases the older per-file refusal
got wrong. A monorepo compiles one pack per root, so a message naming no pack sent the author to
read all of them; and a pack whose `match.extensions` happened to select no file was compiled,
indexed and reported as a success, with the strategy it declared never reached and its root silently
empty.

**What `symbol` sees is a line partition, not a parse.** Every top-level match of `symbolPattern`
opens an extent that runs to the line before the next match, and the last one runs to the end of the
file. That is the whole bargain of this engine restated at node granularity: every rule in it is a
regex over masked text, and a real scope tree would need a parser per language, which is the thing a
language-agnostic pack contract exists to avoid. The consequences follow, and none of them is hidden
here.

A declaration not written at column 0 opens no extent. The shipped pattern anchors at `^`, and every
language this strategy suits indents a nested declaration, so a function declared inside another
function is read as part of the enclosing export rather than as an export of its own. That is the
property that makes the partition safe enough to answer with, and it is a property of the pattern
rather than of the engine.

An extent begins where the declaration begins, which is not always the keyword, and saying where
that is belongs to the pack. A decorator is written on the lines **above** the thing it decorates, so
a pattern anchored at `export` leaves `@Injectable()` inside the extent of whatever was declared
above it. That is not a cosmetic off-by-one: the reference scan then finds `Injectable` in the
neighbour's extent, which is enough to suppress the "nothing references this binding" fallback, and
the import is attributed to the class written above rather than to the class being decorated. The
decorated class gets no edge at all, which is under-attribution, the one direction a blast radius may
not be wrong in. The repair is the pack's, because a decorator is a language's spelling and the
engine holds the verbs while the pack holds the sentence: the typescript `symbolPattern` takes a run
of decorator lines immediately above the declaration as part of the match, so the extent opens on the
first of them. Angular, NestJS, TypeORM and MobX all write this shape, and all of them write
decorators that span lines, so the run admits a continuation line that is indented or opens with a
closing bracket. It admits nothing written at column 0, which is what stops a run of decorator lines
over an unexported declaration from swallowing the next export and costing it its node.

Text between two exports belongs to the export above it. A helper written at column 0 between two
exported declarations is inside the earlier one's extent, so a capture on its lines is attributed to
the earlier export. There is no third answer available to a partition: the alternatives are to invent
an owner or to give the line to everything, and giving it to the neighbour it was written under is
the one that matches how the file reads.

A name declared twice owns two extents and is still one node. TypeScript merges declarations as a
matter of course: a type beside a function, an interface beside a value, a `declare module` beside
what it describes. Every match opens a boundary, including the repeat, because the alternative is
that no boundary opens at the second declaration and its whole body is read as the tail of whatever
was declared above it, which credits that neighbour with every import the second body needed and
leaves the name itself with none. The extents fold back into one node where nodes are made, so
`graph.json` still holds one node per id and a reader never sees the name twice.

A file whose pattern matches nothing yields exactly the file-level node it always did, with no
`symbol` field on it. Test files, Vue single-file components and barrel files are the ordinary cases
in a TypeScript repository, and this is why adopting the strategy moved nothing about how they are
ided, counted or resolved. Ordinary cases and not a rule: a test file that exports its cases yields a
node per export like any other file, and a `.vue` writing `export const` at column 0 does too. The
pattern decides it and the extension never does.

**What the shipped pattern does not read is worth the list, because it is not the list the shape of
it suggests.** An export form the pattern has no branch for keeps its lines inside the neighbouring
extent, or leaves the file with no export at all and therefore with its file-level node. The forms
are: a re-export naming what it re-exports (`export * from "./x"`), an `export { a, b }` clause
listing names declared elsewhere in the file, a declaration written anywhere but column 0, a binding
destructured out of an expression (`export const {a, b} = …`), a CommonJS `module.exports`, and the
one that costs the most while being the easiest to leave out, an **anonymous default export**. The
pattern requires a name after the keyword, so `export default () => {}`, `export default {…}`,
`export default class {}` and `export default function () {}` all match nothing and the file keeps
the file-level node it had before. That is the ordinary React and Vue component export form, so it
reaches far more real files than the `export { a, b }` clause a list like this usually stops at, and
a reader who assumes per-export ids everywhere in a React codebase will find whole directories still
ided by path. Every one of them fails in the same safe direction: the export is not a node of its
own, so a reference to it is attributed to the file or to a neighbouring export, which is too wide
rather than lost.

**An import is attributed to the exports that reference what it binds.** An import statement is
written above every declaration in the file, so no extent encloses it, and both of the easy answers
are wrong in the direction that matters: giving it to the first export invents a dependency, and
giving it to all of them is the file-level answer this strategy exists to stop giving. So the engine
reads the names the statement binds and attributes it to the exports whose own lines reference one of
them. Where nothing in the file references the binding, the import is attributed to every export of
the reading file, and the same fallback runs again on the far side: where the statement binds no name
the target module exports under that spelling, the edge reaches **every** export of the target module
rather than none. A side-effect import binds no name at all, a dynamic `import()` binds none at the
statement, and a default or namespace import binds a local name that the target need not export under
that spelling, so all three land on the whole module. In each of those the honest answer is that any
export of that file may be the one reached, and the closing line of every report already says the
flow list is a floor rather than a ceiling. This fallback is that floor and not a ceiling: it
over-reaches rather than under-reaches, which is the only direction a blast radius may be wrong in.

**`kind`, `isTest` and `assertsValue` stay file-level facts, copied onto every node the file yields.**
A `kindRules` entry reads a path glob and a content pattern over the whole file, and a test file
asserts or does not assert as a file. Naming any of the three per symbol would be inventing a
distinction this contract does not draw anywhere else, so the copy is the honest representation of
what was actually measured.

`fallback: "path"` covers the files the strategy cannot name: a route file, a bootstrap script,
anything with no class declaration in it. Without it those files yield no node at all, and
everything they declare (routes above all) is invisible to the graph, so a `fqcn` pack for a
framework with route files wants it. Leave it unset when a file with no unit of code should simply
be skipped.

`indexNames` is what module resolution needs, under `module-path` and under `symbol` alike, since
both turn a specifier into a file before they turn it into an id: the basenames that stand for
their own directory, so `import "../components"` finds `components/index.ts`. It is declared rather
than assumed because "index" is a Node convention and Python's answer is `__init__`. An engine that
hardcoded either would be a language leaking into the engine, which is the one thing this contract
exists to prevent. A pack that declares none resolves no directory imports, which is correct for a
language that has no such notion.

`kindRules` tag a node with a semantic kind (model, job, route-file, component, screen) by path
glob or content pattern, first match wins. Kinds drive both flow mapping and the review's
project-specific red flags.

`resolvedBy: "framework"` marks a kind the framework reaches by name or by convention, and not
through any edge the pack's rules could see: a blade view rendered by `view($name)`, a
migration the runner discovers, a policy found by its class name. Those nodes can sit at a fan-in of
zero whether they are used or not, so **the absence of an edge is not evidence about them**, and
`empo query --orphans` excludes them rather than offering them as dead code. Left unmarked, a Laravel
repository answered `--orphans` with 296 nodes of which essentially none were dead: 142 of
them views. This is the whole promise failing in one command, and it is fixed in pack data rather
than in the engine because which conventions a framework resolves is exactly the kind of knowledge
a pack exists to hold.

It is an enum with one member rather than a boolean, because the useful fact is *who* resolves the
node. The next value somebody wants (a DI container, a plugin registry) is then a sibling instead of
a second flag, and nobody reading `true` has to guess which of them was meant. The engine treats
every value the same today; only `empo query` reads the field at all, and it reads it from the pack
on disk rather than from the graph, so an existing `graph.json` gets the corrected answer with no
rebuild.

Mark a kind here only when the framework really is the caller. A model is imported, a job is
dispatched, and a service provider is named as a string in `bootstrap/providers.php`, which the
`string` edge family already catches. Nothing reaches one of those except through an edge a rule can
see, so a fan-in of zero on it is a genuine dead-code candidate, and marking it would hide a true
positive. The question to ask is whether deleting the file would break the application even though
nothing in the repository names it.

The mark says **who** resolves the kind, not how many edges an instance of it has, which is why a
rule that sees some of a kind does not unmark it. The `view` strategy reads the literal spellings
(`view('orders.show')`, `@extends`), so those blade files now carry a fan-in and leave the candidate
list through the fan-in test rather than through this one; the ones reached by `view($name)`, a view
composer or a computed `@include` are reached by nothing any rule can see and stay exactly as
invisible as they were. A count could not tell those two apart, and calling the second kind dead is
the mistake the mark exists to prevent.

Ordering matters more once these exist, because kindRules are first match and the default `class`
rule has no glob and therefore matches everything. Every framework glob in the php pack sits ahead
of `model`, `job` and `class`, and the globs are the conventional Laravel locations (`routes/`,
`resources/views/`, `database/migrations/`, `database/seeders/`, `database/factories/`, `config/`,
`bootstrap/`, `app/Policies/`, `app/Console/Commands/`, `app/Livewire/`), matched root-relative like
every other `pathGlob`. `**/Livewire/**` is written that way deliberately, so it catches both the
Laravel 11 location and the older `app/Http/Livewire/`.

**A rule may require both signals, and the typescript pack's React rule is the case that needs it.**
An entry declaring a `pathGlob` and a `contentPattern` matches only where both hold (`kindOf` in
`engine/extractor.ts` ANDs them), which is what lets a pack mark a React component when neither half
is a marker on its own. The glob is `**/*.{tsx,jsx}`, because the extension is where JSX is legal;
the pattern requires a real tag, closing or self-closing, because a `.tsx` that renders nothing is
not a component. Each half is load-bearing in a different direction. The glob alone promotes every
hooks module and every type module written in `.tsx` beside the components; the pattern alone runs
over all seven extensions the pack claims, and a `.ts`, `.js`, `.mjs` or `.cjs` file naming a tag is
reached by no earlier rule. `.vue` is not part of that argument: the pack's own `**/*.vue` rule sits
ahead of this one, so a `.vue` file never reaches this pattern whether it is scoped or not.
**A React component written in a plain `.js` file is deliberately left `module`**,
and that is now a decision about the extension boundary rather than a defence against strings: the
rule declares `"maskStrings": true` (section 4), so the string defence would travel with the glob if
anybody widened it, and what is left to argue is only whether `.js` is where JSX lives. The pack says
it is not. The rule sits after `**/screens/**`, `**/components/**` and `**/api/**` and
before the catch-all `module`, so a role directory still wins, which is the ordering the pack's
`**/*.vue` rule already relies on. The corpus pins the refusal and not only the match:
`src/legacy/OldOrderScreen.tsx` holds no tag and stays `module`.

**What the glob narrows it is not what it eliminates, and the rest of it is closed by the same field
the tag rules use.** A `.tsx` whose only tag-shaped text sat inside a string literal was kinded
`component` though it rendered nothing, because the pattern deliberately allows a lowercase tag (a
React component rendering only html is a component) and a kind rule read string contents as written.
The glob kept that failure inside `.tsx` and `.jsx` rather than removing it. `maskStrings` is now a
field on a kind rule as well as an edge rule (section 4), the React rule declares it, and its
`contentPattern` reads the string-blanked view instead. That moved the typescript pack from 1.6.0 to
1.7.0; the php pack declares the field nowhere and is untouched.

Measured, not argued. Declaring the field moved no node the corpus already held: 63 edges before and
63 after, and not one kind changed. `src/packs/typescript/fixtures/src/src/react/cards/CardTemplates.tsx`
is the whole of the difference, a `.tsx` under no role directory whose only tag-shaped text sits in
two string literals and which renders nothing. Drop `maskStrings` from the rule and that one file
goes back to `component` while every other line of the snapshot stays as it was. Its sibling
`CardDocs.tsx` pins the other half from a file that holds both shapes: it renders a real
`<OrderCard />` and names two more components in strings, and it stays `component` throughout, so
the rule declines to read prose without declining to read the tag beside it.

**It was a wrong label and not a wrong edge, and the reason to close it anyway is `targetKinds`.**
`resolveName` in `src/engine/resolver.ts` (`uniqueId` when this was written) gates every
`short-name` resolution on the target node's kind, so `targetKinds`, the clause that exists to
refuse a tag landing on a same-named
non-component, reads exactly the field this defect corrupted. A file over-promoted to `component`
was a file a tag was allowed to land on, and the refusal stopped working with nothing said. It cost
a wrong edge only where such a file was also the lone carrier of a name somebody renders, which is
why it stood as a label defect for as long as it did. That is a bound and not an absence, and a
bound is a poor thing to leave a silent refusal standing on.

The price is the one the edge rules already accepted, and it lands on the label instead of the edge:
prose that looks like a literal is blanked like one, so a component whose only tag-shaped text sits
inside the apparent quotes loses its `component` kind and falls through to `module`. **The backtick
is the wide case and it is worth stating exactly, because it is not confined to one line.** `` ` ``
is in the typescript pack's `multilineQuotes`, so two literal backticks in JSX text open and close a
literal across however many lines lie between them, and every tag in between goes with them. A help
panel written as

```jsx
Press ` to open the console.
<Console />
Press ` again to close it.
```

renders a real component and is kinded `module`, because the blanked `<Console />` was the file's
only evidence and a `<>` fragment closer matches no tag pattern. An apostrophe is the narrow case: it
may not hold a raw newline (section 3), so it reaches only to the end of its own line, and prose like
`<p>It's here <Badge /> and that's it</p>` keeps its kind anyway, because the `</p>` outside the
apparent literal still answers the pattern. A file that under-reports
its kind is a file `targetKinds` refuses a tag on, which is a missing edge; a file that over-reports
it is one `targetKinds` waves through, which is an invented one. The direction is the same one
section 4 takes for the edge itself.

`arrivedBy: "user"` is a **second axis over the same rules**, and it answers the other question a
zero-fan-in node raises. `resolvedBy` says who reaches this kind, so the absence of an edge is not
evidence about it. `arrivedBy` says somebody outside the code arrives here, so a journey starts at
it: a request hits a route file, an operator runs a console command, a page mounts a Livewire
component. `empo init`'s map brief ranks the marked kinds first and drops the framework-resolved
kinds nobody arrives at ([06-cli](06-cli.md)).

Neither axis can be derived from the other, which is why there are two. All three kinds the php pack
marks `arrivedBy` also carry `resolvedBy`, and that is not a contradiction: the framework reaches
the file by name **and** a user walks in through it. Reading one field as the other is what made this
worth building. `--orphans` asks "is this dead?", where framework-resolved means a fan-in of zero is
no evidence either way and so hide it; the brief asks "does a journey start here?", where a route
file is emphatically yes. Reusing the first answer for the second question throws away every route file,
console command and Livewire component, which on a Laravel repository is very nearly the whole
entrypoint list: on one census of 285 entrypoints it would have left 7.

Mark a kind here only when somebody outside the code really arrives at it. A view is rendered by a
controller the user already reached, a migration is run by a deploy, a policy is consulted
mid-request: none of the three is where a journey starts, and marking one ranks it above the kinds
that are. A kind carrying neither mark is **unclaimed rather than denied**, and the brief prints it,
so the cost of leaving a kind alone is nothing and the cost of marking the wrong one is a worse
list.

It is an enum with one member for the same reason `resolvedBy` is: a scheduler and a webhook sender
are the sibling values to want next, and neither is a user. Both fields are read from the pack on
disk at the moment the question is asked, never stamped onto a node at index time, so a pack that
gains a mark corrects an existing `graph.json` with no reindex. `src/engine/kinds.ts` owns both, and
owns them in one module rather than one per command, because `empo query --orphans` and the map
brief classify the same nodes and a second copy of the rule would let the two disagree.

### 3. `comments`: what is not code

Regex-over-source cannot tell code from a comment quoting code, and every real codebase is full of
commented-out routes and notes like "the old flow called `\Acme\Price\Calculator::total()`
here". Before any rule runs, the engine blanks every comment the pack declares, replacing it with
spaces so the source keeps its length and its newlines and every line number stays correct.

This is not tidiness. A phantom entry in `produces` becomes a phantom **bridge** edge in phase 2, so
`empo query` would report a mobile screen coupled to a route that does not exist, with a `file:line`
citation pointing at a comment. Absence of an edge is a documented blind spot; a confident wrong edge
is a broken promise.

`stringQuotes` and `stringEscape` exist only so the masker knows where a comment does not start:
`'https://acme.test'` must not blank the rest of its line. String **contents** are left as written
unless a rule asks otherwise, through `maskStrings` (section 4), and for almost every rule they must
be: the `string` edge family is a class name inside quotes, php's `@livewire('cart')` is a component
name inside quotes, and every route path a `produces` or `consumes` rule reads lives inside one. The
one shape that needs the opposite is a rule whose pattern can only ever describe code, an edge rule's
or a kind rule's alike, and it asks per rule. Both views are built once per file and only where some
rule asked for the second, so a pack with no asker pays nothing and a pack whose only asker is a kind
rule still gets it. When a rule does ask, only the **contents** go and the quote characters stay
standing, and the blanking
preserves length and newlines exactly as comment masking does, so both views of a file share one
`lineStarts` and a capture from either cites the line a reader will actually find.

`multilineQuotes` names the quotes whose literal may hold a raw newline. It has to be declared
because two languages disagree: PHP's `'...'` spans lines, while JavaScript's `'...'` and `"..."` may
not and only its backtick may. Absent means every quote may, which is PHP's rule and the masker's
original assumption. It matters most in a Vue SFC, where an apostrophe in template prose ("the
customer's currency") would otherwise open a string that swallows every real quote after it. A field
the schema does not name is stripped at load, so this is a real field and not a convention: a pack
that declared it under a schema that did not carry it lost it silently, and the masking fix that read
it stopped working with no error.

A pack that declares no `comments` block is masked not at all, which is the old behaviour. The php
pack deliberately declares `//` and not `#`: PHP 8 writes attributes as `#[Route(...)]`, and blanking
those would hide real couplings. A `#`-style comment holding a class name is therefore a known,
accepted blind spot.

**`commentsByExtension`** lets one pack hold two syntaxes, keyed by a dotted extension (`.vue`). One
language is not always one comment style: a Vue single-file component's `<template>` is html, where
`<!-- -->` is a comment, but the pack's `.ts` files must not treat `<!--` as one, because `a <!--b`
is `a < !(--b)` and reading it as a comment opener with no closer blanks the rest of the file. A file
is masked with its extension's override when one is declared and with the base `comments` otherwise,
and the value is a whole syntax rather than a patch over the base, so what applies to a file is one
object read in full.

A key is matched as the **longest declared dotted suffix of the file's name**, not as its last
extension segment. Compound extensions are real in several languages (`card.blade.php`, `main.d.ts`,
`styles.module.css`), and `posix.extname` answers only the last segment of one, so a `.blade.php`
key could never be selected and a pack declaring one would go on masking Blade as plain PHP: every
`{{-- --}}` unrecognized, and the first rule that fires inside commented-out template text becomes an
edge citing a comment. Longest wins, so a pack may declare `.php` and `.blade.php` side by side and
the more specific one takes the file. The leading dot every key carries is what makes suffix
comparison safe rather than clever: `foo.mts` does not end in `".ts"` and `x.notblade.php` does not
end in `".blade.php"`, so a key can never claim a file whose extension merely ends in the same
letters.

An embedded template language is where the pack of the host language usually wants to declare **no**
`stringQuotes` at all. The php pack's `.blade.php` entry does: Blade's own parser treats `{{--` as a
comment opener regardless of quoting, so string tracking protects nothing there, while an apostrophe
in template prose ("the customer's balance") is common and is the one thing it could break.

### 4. `edges`: intra-language coupling

Six edge families, each a list of `{ pattern, resolve }` rules. `resolve` names the strategy that
turns a captured string into a target node id:

| `resolve` | Turns a capture into |
|-----------|----------------------|
| `fqcn` | a class-id node, directly |
| `fqcn-string` | same, but the capture was a quoted string (morph maps, `call_user_func`) |
| `module-path` | a module-id node by resolving a relative import against the importing file |
| `view` | a template node by resolving a view name against the framework's view roots |
| `observer` | a hook edge from the observed model to the listener class |
| `short-name` | a class-id node by looking one short name up in the index of names, exact spelling first and a case fold only where that finds none, and a fold only where the reading file's own import corroborates it |

A TypeScript pack uses `import` with `resolve: module-path` and has no `hook` family. The php pack
that ships uses all six, `template` included since it gained the Blade component tag and `inherit`
since it gained the two `extends` rules, and the
typescript pack now populates `template` too, from a JSX tag and from the same tag in a Vue SFC. The
engine does not care which families a pack populates.

**`inherit` is the family a pack declares for the reference its `import` rules structurally cannot
see**, and php is the case it was written for. A class extending a sibling in its own namespace
writes no `use` statement, because php resolves the bare name against the current namespace, so no
import rule can be written that would find it — the statement is not there to be matched. The php
pack declares two rules over a `class` declaration, each allowing `final`, `abstract` and `readonly`
in front of the keyword. The first reads `class Foo extends Bare` and resolves by `short-name`,
because a bare parent name says nothing about where the parent lives and has to be looked up in the
index of short names exactly as a Blade tag is; it requires the captured name to be followed by
`implements`, an opening brace or the end of the line, so what it captures is a whole parent name and
never the head of one. The second reads
`class Foo extends \Fully\Qualified\Base`, capturing the qualified name without its leading
separator, and resolves by `fqcn`.

Between those two sits a spelling neither reads: `class Foo extends Sub\Base`, a parent named
relative to the current namespace. The bare rule stops at the backslash and the qualified one
requires a leading separator, so the reference yields no capture and no refusal — it is not counted
anywhere. Resolving it needs the reading file's own namespace prepended to the capture, which is a
resolve strategy this engine does not have, and inventing one for a spelling php code uses rarely
would buy an edge at the price of a strategy nothing else needs.

That the second rule uses the `fqcn` strategy is also the reason the family is not simply more
`fqcn` rules: **the strategy and the family answer two different questions.** `resolve` says how a
capture becomes a node id, and the family says what kind of reference the capture was, which is what
the graph's `kind` column and `empo query`'s edge list are read for. An inheritance is not an
inline mention of a class the file happens to call; it is the declaration that half the subclass's
behaviour lives elsewhere, and a reader deciding what a change can break wants those told apart. A
pack for a language that spells inheritance some other way declares its own rules here and the engine
learns nothing new, which is the same contract every other family has.

**The `short-name` refusals of section 4's name resolution apply to the first rule without
exception, and one of them is worth stating for class names specifically.** A bare parent name that
two nodes in the repository carry resolves to neither: no edge is emitted, in either direction, and
the reference is counted `ambiguous` in this family's `names` record rather than guessed at. A parent
name in no node at all is `unknown`, and in a framework codebase that is the normal and correct
answer for most of the misses rather than a gap: `extends Model` and `extends Command` name Eloquent
and Laravel base classes that live in `vendor/`, which this repository's graph holds no node for, and
refusing them is the same refusal a vendor component tag gets. Measured on a real Laravel repository
the family read 3379 names and resolved **2564**, with **139** ambiguous and **676** in no node.

**Declaring this family changes the numbers of every php repository already indexed, which is why it
is a pack version bump — the php pack moved from 1.12.0 to 1.13.0 for these two rules — and not a
free win.** Inheritance is dense in framework code — jobs, commands,
controllers, models and test cases all declare a parent — so the family lands on many pairs the
other five never touched. On that repository one abstract job with nineteen subclasses had a graph
fan-in of **3** — two subclasses that sat a namespace deeper and therefore had to import it, plus one
class that imports it without extending it — and a fan-in of **20** after the rules were declared; the repository as a whole went from **17725** edges
to **20292**. A fan-in, a god list or a blast radius written down before the bump does not survive
the next `empo index`, and it does not survive it because the graph had been missing those edges.

A rule may carry **`normalize`**, a list of the same string operations `produces`/`consumes` use,
applied to every capture group before `resolve` reads it. It exists because a call site and a
declaration can spell one name two ways: a Blade `<x-forms.text-input>` names the class
`Forms\TextInput`, and that a component tag is kebab-cased with dotted namespace segments is a fact
about Blade, not about graphs. Composing `last-dot-segment` then `pascal-case` turns the one spelling
into the other and no engine code learns the word Blade. Group 0 is left exactly as matched, because
no strategy reads it and a normalized whole-match would record text no file contains.

A rule may carry **`pathGlob`**, which says where it is allowed to run, as a glob over the
root-relative path in the same dialect `kindRules` and `tests.paths` use. It exists because a rule's
reach is the whole pack: an `edges` rule runs over every file `match.extensions` claims, and the
typescript pack claims seven extensions of which two can hold JSX. A tag rule left unscoped reads
`"<Widget />"` out of a string in a `.ts` file, because a rule reads the source as written unless it
says otherwise (section 3, and every route path lives inside a literal), and emits an edge to a file
that source neither imports nor renders. A rule the path excludes never runs at all, so it can
neither match nor cost anything, and a rule declaring no `pathGlob` runs everywhere, which is what
every rule did before the field existed.

**It is the first half of that answer and not the whole of it**, which is worth saying because it was
first written here as the whole. A glob separates files, and the string problem is not a property of
a file: a `.tsx` naming a component inside a quoted string is exactly the file the tag rules exist to
read, so there is no glob that keeps `const tip = "<Button />"` out while letting a rendered
`<Button />` in. `pathGlob` closed the `.ts`/`.js` face and could close no more of it. The second half
is `maskStrings`.

A rule may carry **`maskStrings`**, which says the rule reads a view of the file with the contents of
every string literal blanked (the quotes themselves stay, so `<Button title="hi" />` is still a tag
with a well-formed attribute rather than a truncated one). Absent means read the source as written,
which is what every rule did before the field existed and what almost every rule still needs. It is
**per rule and not per family**, and that is load-bearing rather than tidy: php's `template` family
carries both `<x-cart>`, which is markup and can only be markup, and `@livewire('cart')`, whose
component name is inside the quotes and vanishes entirely if they are blanked. A per-family or
per-pack flag would have to pick one of those two and be wrong about the other.

**It is a field on a kind rule too**, where it does the same thing to `contentPattern` (section 2).
The reason for the second half is not the label's own display but `targetKinds` above it: a kind is
read like an edge, because `resolveName` in `engine/resolver.ts` checks a tag's target against
exactly that label, so a file over-promoted off tag-shaped text in a string becomes an eligible
target and
the refusal goes quiet. Declared per rule there for the same reason as here, and it is the same
reason twice rather than a coincidence: a pattern describing code asks for the blanked view, a
pattern keying off a string the framework itself reads must not.

The typescript pack's two `template` rules declared it first, which moved that pack from 1.5.0 to
1.6.0; its `**/*.{tsx,jsx}` kind rule declares it now, which moved the pack to 1.7.0 (section 8's
pin demands the bump rather than trusting anybody to remember it). The php pack declares it nowhere
and is untouched by either change, and the edges it emits are byte-identical before and after.

Two ways of declaring the field are **rejected at load** rather than accepted and ignored. Declaring
it where some extension the rule can read names no `stringQuotes` is refused for either rule kind:
the masker finds a literal only through those quotes, so the flag would be inert for those files, and
a rule that asked not to read prose would go on reading it with nothing anywhere to say the request
had been dropped. The next paragraph is how "can read" is decided. Declaring it on a **kind rule
carrying no
`contentPattern`** is refused as well, because such a rule reads no source at all: the flag would
change nothing while reading to anybody auditing the pack as a guarantee that this kind cannot be
won off the contents of a string. Both
are the failure shape `multilineQuotes` was bitten by in section 3, a declared field the schema
stripped at load while the masking fix that read it quietly stopped working, and the remedy is the
same one: make the honest answer arrive at load, where a message can name the pack and the rule's
position in its family or in `kindRules`.

**The `stringQuotes` check is per extension, because the masker is.** A pack-wide check would pass as
soon as `comments` or any one `commentsByExtension` entry named a quote, while `commentSyntaxFor`
picks the syntax by the file's own extension, so a pack declaring quotes on `comments` and omitting
them from `commentsByExtension[".tsx"]` would load clean with `maskStrings` inert for exactly the
files it was written for. Measured before the check was tightened: the typescript pack with that one
entry rewritten kinds `src/lone/Tips.tsx`, holding only
`export const tip = "render a <Tips /> here";`, as `component`, and the invented `template` edge
comes back with it.

So the check resolves each declaring rule's reach instead. The candidate suffixes are
`match.extensions` together with every `commentsByExtension` key, which is how a **compound**
extension gets considered at all: `.blade.php` is never in `match.extensions`, because the scanner
admits the file through its plain `.php` tail, and `posix.extname` answers `.php` for
`card.blade.php`, so a check reading either alone cannot see the entry that actually masks the file.
A rule with no `pathGlob` reaches all of them; a rule with one reaches those its glob matches. Each
reachable suffix is then resolved the way the masker resolves it, longest declared dotted suffix
first, and a syntax that is missing or declares no quotes names that extension in the error.

Two remedies, and the pack author picks: declare the quotes for that extension, or scope the rule
away from it with a `pathGlob`. Both are checked in the corpus. Note that `**/*.php` is **not** a way
to scope away from `.blade.php`, because `*` matches `card.blade` and the glob therefore does reach
blade files; excluding them takes a glob that says so.

A rule may carry **`targetKinds`**, the list of node kinds a name-resolving strategy is allowed to
land on, read from the target node's own `kindRules` answer. Only `short-name` and `observer` resolve
a bare name, and only they read it. It exists because a name is only as safe as the namespace it
resolves into, and a JSX tag's namespace is mostly other people's packages: `<View>`, `<Text>` and
`<Link>` name nothing in this repository, their vendor import resolves to no node and leaves no
competing edge, so a local file that happens to share the basename collects the tag and is then the
only thing the graph says about that pair. **The filter is applied first and the uniqueness question
is asked of what survives it.** A node of a kind the rule does not list was never a second reading of
the reference: the rule declaring `["component"]` is the pack saying what a tag of this family can
denote, so such a node is a different thing that happens to be spelled the same, and counting it
makes the name ambiguous against a candidate that could not have won. Two nodes the rule's own kinds
both admit are still refused, because there the field really does hold two readings and narrowing it
would be a guess.

This order was tried, rejected, and adopted, and the record of why is worth keeping whole rather than
quietly reversing. It was rejected on a measurement: in a repository holding both
`components/Link.tsx` and `util/Link.ts`, a `<Link />` that names react-router's component resolved
to the local component under the filter-first order and to nothing under the filter-last one, and the
tag names neither file. Narrowing the candidate list did not make an unreadable name readable, it hid
the ambiguity behind a plausible pick, which is a confident wrong answer where the refusal was merely
a missing edge.

Two things changed. **`importsVendorName` was added afterwards**, and it is asked of the one name that
was about to become an edge, which is exactly the position this order delivers a name into. The
`<Link />` case is now caught by the guard built for it: the file's own import says the name came from
a package the repository depends on and does not carry, so the verdict is `vendor` and no edge is
written. An ambiguity standing in for a vendor check was never load-bearing anyway, since it only
fired where a second local file happened to share the name.

And **the `symbol` node-id strategy made the cost of the old order unpayable**. While a node was a
file, a short name was a file basename and two files of different kinds rarely shared one, so asking
the kind last cost almost nothing. Under per-export ids the namespace is every exported name in the
repository, and a single `export const Modal = ...` in a constants file is then enough to refuse every
`<Modal />` in the codebase. That refusal takes every edge to the name with it, including the ones
nothing else covers: a globally registered component that no import binds has no other evidence, so
the coupling disappears and no count reports that it went missing. Both orders can lose an edge; only
the old one loses edges that nothing else records. `resolveName` in `engine/resolver.ts` carries the
argument and `test/engine/resolver.test.ts` pins all three cases, the vendor one included.

Which kinds a tag can name is a fact about the language, so it stays pack data like every other
language fact, and the kind and the rule are declared in the same file.

The strategy list is engine-side and closed: a pack selects one, it cannot define one. All six are
built. Note that `view` and `short-name` are different strategies for different jobs and neither
replaces the other: `short-name` is template-to-**class**, and `view` resolves a view **name**
against the framework's view roots, which is the only thing in the model whose target is a template.

**`view` is what makes a template a sink.** Before it, every rule that mentioned a template made it
a source: a blade file named the component classes it rendered and nothing named the blade file, so
a change to a controller or a route never reported the page it draws — the direction a reviewer
actually asks about. Measured on a real Laravel repository, 69 blade files on one journey had zero
incoming edges. Every spelling lands on the same strategy, because they are one question: a template
naming another (`@extends('layouts.app')`, `@include('orders.row')`), a class naming one
(`view('orders.show')`, `View::make(...)`) and a route naming one with no controller in between
(`Route::view('/about', 'pages.about')`, whose **second** argument is the template).

What each of those looks like as a pattern is pack data and stays there, and three of the four rules
carry a lookbehind for the same reason `short-name`'s refusals exist. `$mail->view(...)` is a method
on somebody's object and `TextView::make(...)` is a class whose name merely ends in the facade's, and
a rule that read every `view(` in the language would invent an edge out of either. So is a **name
qualified by a namespace**: `Acme\View::make(...)` and `Acme\view(...)` are an application's own
class and function, and the framework's are reachable unqualified or behind the one leading separator
that means the global namespace, so each lookbehind excludes the separator while the pattern admits
an optional leading one. What that last refusal costs is the fully-qualified inline facade,
`Illuminate\Support\Facades\View::make(...)`, which real code writes as a `use` and a bare
`View::make(...)`; a missed edge is the acceptable direction and an invented one is not.

The `views` block is checked against `match.extensions` at load for the same reason the block is
required at all. `scanRoot` globs `**/*<extension>` per entry in `match.extensions`, so a template
whose name ends in none of them is never read and never indexed, and a pack declaring `.twig` beside
a php `match` block would pass every other check and ship a family that cannot produce an edge.
`.blade.php` qualifies through its plain `.php` tail, exactly as a compound `commentsByExtension`
key does.

What it resolves is a **path below a root**, never a name looked up in the index of node names. A
view name is not a short name: `orders/show` is where the file sits, and the only thing no line of
the repository writes down is which directory that is, which is what the `views` block below says.
So the strategy shares none of the four further questions `resolveName` asks around its uniqueness
test, the kind, the reading file's own declarations, its imports and its workspace packages, because
not one of them can say anything about a path. What it does share is the refusal: a name in no template and a name in
several both yield nothing, and both are counted in `names` beside the `short-name` verdicts, since
a strategy whose yield can quietly be zero is not one anybody can call proven.

The name is spelled with dots at the call site and with slashes on disk, and that is a Blade fact
rather than a graph one, so it is the pack's `dot-to-slash` normalizer that closes it and no engine
code learns the word Blade.

The roots come from the pack's optional **`views`** block, which the `view` strategy is the only
reader of and which a pack naming that strategy must declare — without it the strategy would resolve
every name against an empty index and the family would ship producing nothing, so it is refused at
load like every other such gap in this contract.

| Field | Required | Meaning |
|-------|----------|---------|
| `roots` | yes | Directory a view name is relative to (`resources/views`). |
| `extensions` | yes | Suffixes a template carries (`.blade.php`, `.php`). The first one the file's name ends in is the one taken off, so declaring the compound suffix before the plain one is what keeps `orders/show.blade.php` from being named `orders/show.blade`. |

A root is matched **anywhere in a repo-relative path**, not only at its start, so one entry covers
both `resources/views/orders/show.blade.php` and a monorepo's
`apps/api/resources/views/orders/show.blade.php`. The cost of that reach is the ambiguity it can
create: two applications in one repository each holding `orders/show` make the name ambiguous and it
resolves to neither, which is the same refusal `short-name` makes and the same reason — a plausible
pick is a confident wrong `file:line` where the honest answer is that nothing here can tell.

`short-name` is the plain form of `observer`: capture one name, look it up in the index of node
names, emit an edge from the file that wrote it. It shares `observer`'s refusal rather than
reimplementing it, which is deliberate, because two strategies that answered "is this name
unambiguous" differently would be a defect invisible from either pack. So a name in no node yields
nothing (a vendor component, or a Blade built-in like `<x-slot>`), and so does a name in several. The
ambiguity bites harder here than it does for observers: `forms.text-input` and `fields.text-input`
both fold to `TextInput`, and a component library with namespaced folders is the normal case rather
than the odd one.

**Which names that index holds depends on the pack's node-id strategy, and that is not a detail.** A
node's short name is the class name under `fqcn`, the file basename under `module-path`, and the
**export name** under `symbol`. So the same repository presents this strategy with two different
namespaces depending on which the pack declared, and the export-name namespace is the stricter of the
two: two files whose basenames differ only in case carry two distinct names under `module-path` and
one shared name under `symbol` if both export it under the same spelling. A pack changing strategy
therefore changes what `ambiguous` means for it, which is why doing so is a major version and why the
counts either side of the change are not comparable. The typescript pack's own corpus records this
happening, at the end of "Testing a pack" below.

**Resolved against refused is counted rather than assumed**, on whatever repository
the pack is pointed at. Every name these two strategies read reaches one of six verdicts, and a
`view` name reaches three of the same six (`resolved`, `unknown`, `ambiguous`), counted into the same
per-family record for the same reason:
`resolved`, `unknown` (the name is in no node at all — a vendor component, a Blade built-in like
`<x-slot>`), `ambiguous` (the name is in several nodes, so no edge is emitted to any of them),
`wrong-kind` (every node carrying the name holds a kind the rule's `targetKinds` does not list, and
the count that comes back with it is how many were found),
`local` (the file that wrote the reference declares that name itself, so no other node can be what
the reference means — the pack's `declares` patterns below are what say so) and `vendor` (that file
imports the name from a package this repository depends on, so the node carrying it is a basename
collision — the `packages` block below is what says so). The
tally is recorded on the graph as `names`, one record per edge family, counted per **reference read**
and not per distinct name, and both `empo index` and `empo doctor` print it
([06-cli](06-cli.md)).
The five refusals are asked in a fixed order and the order is load-bearing.
Where the rule declares `targetKinds`, the filter is applied first and the uniqueness question is
asked of what survived it, so a name carried by two nodes of which only one is a legal target
resolves to that one, and a name carried by two legal targets is still ambiguous: `resolveName` in
`engine/resolver.ts` drops what the rule could never have named before it counts, and its docstring
records why. Where the filter leaves nothing the verdict is `wrong-kind` and it reports how many were
found, because the name is in the graph and what a reader needs to know is that the rule declined it,
not that nothing carried it. `local` and `vendor` are asked **last**, of
the one name that was about to become an edge, for the reason the two paragraphs on them below give.
That order is also why the refusals are
counted apart: `ambiguous` is the only one of the five that hides a coupling this repository really
has, `unknown` is the ordinary cost of reading a language whose vendor components are spelled like
local ones, `wrong-kind` is a rule's own `targetKinds` doing what it was declared for, and `local`
and `vendor` are the two where a node was found, was of the right kind, and is still not what the
line renders.

**It bites harder again in React, and now with a number.** The refusal is per name and not per
reference, so one duplicate basename anywhere in the repository removes every edge to that name,
including the ones written in a file whose own import says which is meant. **Measured**
on a synthetic 16-file React tree: adding a second `OrderTable.tsx` under another feature directory
took it from 12 template edges to 7, in silence, and on a 640-file copy where every component name
was 40-way ambiguous no template edge resolved at all. It fails safe, which is the right direction.
`targetKinds` does not soften that measurement at all, and it does not soften it under the shipped
order either. A second `OrderTable.tsx` is a second component, so both copies survive the kind filter
and the count is what refuses; the filter only ever removes a candidate the rule could not have
named, and a duplicate of the very kind the rule asked for is not one of those.

**What the count changed is the silence, and not one of those two measurements.** Stated plainly,
because the distinction is easy to lose: counting the refusal is not narrowing it. The second
`OrderTable.tsx` still takes the 16-file tree from 12 template edges to 7, the 640-file copy still
resolves no template edge at all, and every name refused before is refused now. What is different is
that both runs say so, so "this family found nothing" and "this family had nothing to find" stop
reading alike — that was the whole of the defect, and a strategy whose yield can be zero without
saying so was not one anybody could call proven. Narrowing the refusal is a separate and larger
change, and nothing here should be read as having made it.

**That larger change landed afterwards, and it narrows the refusal in exactly one direction: case.**
A file naming convention is not a language. `<Badge />` is written `Badge.tsx` in one React
repository and `badge.tsx` in the next, and both are a component this graph holds, so `buildNodeIndex`
now keeps a second index keyed by the lower-cased name and `resolveName` asks it **only** where the
exact spelling is carried by no node at all. The order is the whole of the safety: a repository that
spells its files as it spells its tags is answered by the exact map and can never be handed an answer
a fold produced. `targetKinds` narrows whatever the fold admitted before the uniqueness question is
put to it, the same order the exact map is read under, so nothing about the two paragraphs above is
softened for a repository that already resolved. **Measured** on a real 186-file React Native
application whose components are all named in lowerCamelCase (`src/components/badge.tsx`, rendered
`<Badge />`): `template` resolved 3 of 1531 tag references before the fold and 735 of 1531 after it,
with 682 in no node and 114 `local`. Every one of those 1528 earlier misses was `unknown`, not one was
an ambiguity anybody could have repaired by renaming a file, which is what says the convention and not
the repository was what the strategy could not read.

**A fold is corroborated before it resolves, and an exact match is not**, which is the other half of
the safety and the half a first version of this section did without. A tag spelled exactly as a file
is the language's own convention answering; a fold is the engine guessing that a naming style is in
play, and a guess needs a witness. The witness is the rendering file's own imports: a folded candidate
stands only where that file carries an `import` capture whose statement text binds the name and whose
specifier resolves — through `resolveModuleFile`, so relative paths and the root's configured aliases
— to exactly that candidate. **Measured** on cal.com, which names its shadcn-style files
`toaster.tsx`, `collapsible.tsx` and `textarea.tsx`: the uncorroborated fold produced 53 extra
template edges there, and a sample of 6 was 5 wrong — `<Toaster />` imported from the `sonner`
package landing on the local `toaster.tsx`, `<Collapsible>` from `@radix-ui/react-collapsible`,
`<TextArea>` from a `@calcom/ui` barrel whose real file is `inputs/Input.tsx`. Corroboration removed
46 of those 53, every refuted one included, and kept the real edge
(`apps/web/app/layout.tsx:167 -> apps/web/app/providers.tsx`, imported as `./providers`). On the React
Native application, where the tags really do name those files, 12 of 12 sampled edges survive and each
was opened at its cited line and confirmed real.

Two consequences of asking the witness **per candidate and before the uniqueness test**. A fold no
import corroborates is `unknown` and not `ambiguous`: nothing was weighed, because nothing was
admitted as a candidate. And a name two files carry once case is set aside still resolves where the
reading file imports exactly one of them — which is not the ambiguity the exact map refuses, since
there is nothing in the file that says which is meant and here the file has said. The cost is at the other
end: a component rendered with no import at all, a globally registered Vue component, is reachable
through an exact-name match and never through a fold.

**The refusal also widened in one direction, and that half needed a new pack field.** A
name-resolving strategy asks the whole root's index which file carries a name, and the one file it
never asks is the one doing the asking — so a story file holding its own `const SelectInput = ...`
and rendering `<SelectInput />` collects an edge to a real `SelectInput.tsx` in another package that
it neither imports nor renders. **Measured** on marmelab/react-admin, 139 of 2715 template edges were
exactly that. A name the reading file declares itself is answered inside that file, so the strategy
refuses it and reports the fifth verdict, `local`: not a coupling lost, a wrong one prevented.
`nameLines` prints it as `N declared where they are used`.

**The check is made last, of the one name that was about to become an edge**, and an earlier version
of this document said the opposite. It ran before the index was consulted, which read well and
measured badly: a name in no node was never at risk of a wrong edge, so a file declaring `Wrapper`
and rendering `<Wrapper />` was counted as a refusal rather than as the `unknown` it honestly is, and
on react-admin that inflated `local` to 2753 references. Asked after uniqueness and after
`targetKinds`, it fires only where the index found exactly one node, of a kind the rule allows, and
the file that wrote the reference says it meant something else — 213 references there, which is the
number of wrong edges the field prevents. It carries `candidates: 1` accordingly, because one node
was weighed and then declined.

Which spellings declare a name is a fact about the language, so it is pack data like every other one,
and the field is **`declares`**: a list of patterns whose **first capture group** is a name the file
declares itself, one per shape the language spells a declaration in. They are compiled with `gm`
and matched against the same string-blanked, comment-masked view the tag rules read, on the same
argument those rules make — a name inside a quoted example is prose about a declaration, not one. The
names one file yields are deduplicated and sorted before they are stored, so two runs over the same
bytes write the same `graph.json`. A pattern that matches and captures nothing contributes nothing:
a pack's own bug is not a declaration, and admitting the empty string would make every
name-resolving strategy in that pack refuse every name it read. **A pack that declares no `declares`
behaves exactly as every pack did before the field existed**, which is the same bargain `pathGlob`,
`maskStrings` and `targetKinds` each struck: the php pack declares none and the edges it emits are
byte-identical. The typescript pack declares three, one per shape TypeScript spells a declaration in
— `function` with its `export`, `default`, `async` and generator prefixes, `class` with its `export`,
`default` and `abstract` ones, and `const`/`let`/`var` followed by a `:` or an `=`, which is the form
every React function component is actually written in. That moved the pack from 1.7.0 to 1.8.0, and
section 8's pin demanded the bump rather than trusting anybody to remember it.

**The package collision is the third repair, and it needed the `packages` block.** It was the wrong
answer neither of the two above could reach: a tag whose component is imported from a **package**
whose name collides with a local file's basename resolved to the local file, because the vendor
import resolves to no node and leaves no competing edge for the name to lose to. `import Button from
'@mui/material/Button'` beside a local `Button.tsx` is the whole of it, and it was not rare — 189 of
react-admin's then 2715 template edges named a MUI component. Nothing in the tag, the file name or
the kind separates it from a real local component. The one fact that does is that `@mui/material` is
a package this repository installs, and the repository writes that down in a manifest, so the
strategy now reads it: a name the reference's own file imports from such a package is refused as
`vendor`, printed `N imported from a package`, with `candidates: 1` for the same reason `local`
carries one.

**What the block declares is field names, never values**, like `aliasSources` below, so composer's
`require` fills it for php the day php wants it exactly as npm's `dependencies` fills it here.
`file` is the manifest basename, matched anywhere under the repository and not only at its top;
`name` is the field holding a package's own name; `dependencies` is the list of fields whose **keys**
are dependency names. `engine/packages.ts` globs every such manifest, honouring the config `ignore`
list, and computes **the dependency names minus the manifests' own names**.

**Both halves of that subtraction matter, and dependencies alone would have been a regression.** A
monorepo imports its own workspaces exactly as it imports npm — `@calcom/ui`, `react-admin`,
`ra-core` are all bare specifiers that resolve to no file here — so a rule that refused every bare
specifier would delete precisely the barrel-reached edges this family exists for, a component reached
through a workspace barrel being the coupling no import parser sees. Subtracting the names the
manifests declare leaves the set that names something outside this repository, and nothing else is
refused.

**No module resolution is performed and `node_modules` is not consulted for anything.** An installed
tree is a build artifact a fresh checkout does not have and CI may prune, and a graph whose refusals
depended on one would answer differently on two machines sitting on the same commit. A manifest is
checked in, which is the same reason `empo index` opens no toolchain config and reads the root's
`aliases` out of config instead. The exclusion is the module's own and does not
rest on the config: `engine/packages.ts` prepends `node_modules`, `vendor` and `bower_components` to
whatever `ignore` holds. It is not defence in depth, it is the one failure this set has that is both
silent and backwards — an installed package's manifest declares its own `name`, `own` is subtracted
from `dependencies`, and reading `node_modules` would take `@mui/material` back out of the vendor set
and stop refusing it, on exactly the checkouts that have run an install. A default nobody may edit
away is the only form that survives a repository editing its `ignore` list.

**Which manifests are read is a per-root question only in the sense that a root carries a pack.**
`buildRoot` calls the reader once per root with that root's pack's block, and the glob runs from the
**repository** root, so what varies between roots is which manifest basename is looked for and not
which subtree is searched: two typescript roots get the same set, and a php root beside them gets
whatever `composer.json` says the day php declares a block. The php pack declares
none, gets an empty set, and resolves every name exactly as it did before the field existed — the
same bargain `pathGlob`, `maskStrings`, `targetKinds` and `declares` each struck.

**The workspace collision is the fourth repair, and it reuses the same block from the other side.**
The `vendor` refusal cannot touch it by construction: a name imported from another **workspace**
package is a name the repository *is*, subtracted out of the vendor set precisely so barrel-reached
edges survive. cal.com's `apps/web/modules/webhooks/components/WebhookListItem.tsx:222` renders
`</Button>` under `import { Button } from "@coss/ui/components/button"`, `@coss/ui` is the workspace
package at `packages/coss-ui`, and the edge landed on `packages/ui/components/button/Button.tsx`
because that is the one node named exactly `Button`. Every question the strategy asks answers yes,
and the one fact that separates the two files is again in the manifests: they say where `@coss/ui`
lives.

**So the manifests are read for a second map, and the rule is a preference and never a requirement.**
`engine/packages.ts` returns the dependency names minus the manifests' own names *and* those own
names mapped to the repo-relative directory each manifest sits in. Where the statement that binds a
name names an internal package whose directory is known, the nodes under that directory are searched
first, exact spelling and then the case fold; exactly one of the right kind is the target, and
anything else falls straight through to the index with nothing about it changed. **Requiring the
resolved candidate to live under that directory would look like the same rule and would delete real
edges**: react-admin's `packages/react-admin` is a barrel whose `index.ts` re-exports
`ra-ui-materialui` and `ra-core`, so `examples/crm/src/deals/DealList.tsx:105` legitimately reaches
`packages/ra-ui-materialui/src/layout/TopToolbar.tsx`, in another package's directory. Searching that
barrel finds nothing, which is exactly what makes falling through the right answer.

This is a **redirect and not a refusal**: the outcome stays `resolved`, no verdict counts it, and no
`NameVerdict` was added, because the reference did become an edge and only its target moved. The fold
inside a named package needs no separate witness the way the general fold does, since the import that
selected the subtree is that witness — which is how `<Button />` reaches a file named `button.tsx`.
A manifest at the repository root maps to `""`, which contains everything and so narrows nothing, and
a name two manifests declare is mapped by neither: glob order is not evidence about which directory
somebody meant.

**Where the four repairs left the numbers.** On react-admin **7409 of 17415** names resolve, with
3142 `ambiguous`, 5617 in no node, 527 of the wrong kind, 213 `local` and 507 `vendor` over 2399
template edges; excalidraw **563 of 1264** (3, 668, 1, 3 local, 26 vendor, 317 template edges);
cal.com **2777 of 5917** (240, 2822, 9, 46 local, 23 vendor, 1755 template edges); the 186-file React
Native application **735 of 1531** (0, 795, 0, 1 local, 0 vendor, 433 template edges). The third
repair took react-admin from 7672 to 7165 and lower was the result rather than a regression, those
references having resolved to the wrong file; the fourth takes it back to 7409 by answering names the
index had to refuse, and **no repository lost an edge to it**: 60 edges added on react-admin, 138
added and 35 retargeted on cal.com, and excalidraw and the React Native application byte-identical,
neither being a monorepo. Of the six edges independent checkers had refuted in the original sample of
38, four are refused — two MUI collisions, one radix collision, and one name a file declared as its
own `const`.

**One residue survives, and it is a ceiling rather than a bug.** A dotted tag contributes its head, so
`<DropdownMenu.Trigger>` in excalidraw resolves to the file holding the namespace object rather than
to the file holding the component.

The alternative for the namespace, declaring a root prefix such as `App\View\Components\` in the
pack, was rejected: that is a property of the repository rather than of the language, composer and
Laravel both let it move, and being wrong about it costs a silently missing edge.

**The typescript pack's two `template` rules resolve by `short-name` as well, and every clause in
them was chosen adversarially rather than written from taste.** One rule reads a closing tag,
`</([A-Z][A-Za-z0-9_]*)(?:\.[A-Za-z0-9_]+)*\s*>`, and the other a self-closing one,
`<([A-Z][A-Za-z0-9_]*)(?:\.[A-Za-z0-9_]+)*(?:<[^<>]*>)?(?:\s[^<]*?)?/>`. Both serve JSX and a Vue
SFC template, which compose with the same PascalCase tag. Both also declare
`"pathGlob": "**/*.{tsx,jsx,vue}"`, `"maskStrings": true` and
`"targetKinds": ["component", "screen"]`, so each rule reads only the three extensions that can hold
a tag, reads them with string contents blanked, and can only land on a node the pack already kinded
as one of the two things a tag names. None of the three fields was in the first version of these
rules, and an adversarial review of it is what put them there.

The first letter must be uppercase, which is JSX's own rule for "this tag is a component and not an
element". It also used to be what kept html written inside a quoted string out of the graph, every
html tag being lowercase; `maskStrings` does that job now, and the clause is left doing only the job
it was for. **What the clause could never do was keep a component name out of one**: to a regex a
file holding `"<Spinner size={2} />"` inside quotes read exactly like a file rendering it, and the
clause that bought the html refusal was the clause that sold this one. No version of the pattern has
both, which is why the answer is a second view of the file rather than a cleverer regex. `pathGlob`
bounded that damage before it was ended, and the bound is still worth naming, because it is what
scopes the family. A `.ts`, `.js`, `.mjs` or `.cjs` module can no longer produce a `template`
edge at all, and neither can a test written in one, which matters because `engine/coverage.ts`
carries reach along every non-bridge edge, so an `expect(html).toContain("<OrderCard />")` in a `.ts`
test used to make that test reach a component it never mounted and a flow through that component stop
reporting blind. **Measured** through the built bundle, on the same 16-file React tree
the family's other numbers come from: a `.ts` registry holding `"<Spinner size={2} />"` and
`"<StatusPill status=\"open\" />"` produced two invented edges before and produces none now, and all
12 real template edges in that tree survive both fields, so neither costs a true positive.

**What that left, a `.tsx`, `.jsx` or `.vue` file naming a component inside a quoted string, is now
closed too, and the trade taken is the point of the entry.** `maskStrings` is what closes it, and it
is a trade rather than a free fix: the masker believes a quote is a quote, so an apostrophe in JSX or
Vue prose opens a literal, and a tag written between two apostrophes **on one line** is blanked along
with them — `<p>It's here <CartBadge /> and that's it</p>` loses the tag. Two apostrophes on separate
lines are already safe, because `'` is not in the pack's `multilineQuotes` and so may not hold a raw
newline (section 3), and a lone apostrophe is safe because the masker never finds its closer and
steps over the character rather than guessing. The **backtick is the wider half of the same trade and
is not confined to a line**: `` ` `` is in this pack's `multilineQuotes`, so two literal backticks in
JSX or Vue text blank every tag on every line between them. Prose about keyboard shortcuts is where
that actually happens. Those two shapes are the new false-negative surface,
and it is the direction this repository already takes on the hazard axis: a missed edge is a gap a
reader can be told about, an invented one is a fabricated finding with a `file:line` under it.

**Measured, not argued.** `react/cards/CardDocs.tsx` in the pack corpus holds both shapes in one
file, which is the arrangement no `pathGlob` can imitate: it renders `<OrderCard />`, which must stay
an edge, and it holds `"<OrderList>rows</OrderList>"` and `"<OrderScreenView />"` in a docs constant,
which must not become edges to files it neither imports nor renders. Without the flag that corpus
carries 16 `template` edges; with it, 14, and the two that go are exactly those two strings — one per
rule, so the fixture exercises the closing-tag rule and the self-closing rule both. Regenerating the
snapshot over the 39-node corpus produced **only additions**: no template edge that was real before
the change is missing after it.

**`targetKinds` closed the second half of the same review, and that one never shipped as a defect.**
A JSX tag's namespace is mostly npm, so `<View>` and `<Text>` from react-native or `<Link>` from
react-router name no node here and their vendor import leaves no competing edge behind. A local
`src/util/Link.ts` that shares the basename then collected the coupling, and it was the only thing
the graph said about that pair. Measured the same way: a `.tsx` rendering react-router's
`<Link to="/orders">` beside a local `src/util/Link.ts` yields no edge now, where before it invented
one. **That is the whole of what the field closes, and the bound is the order above**: it rescues the
case where the local twin is the lone candidate, which is the measured one, and where two local files
carry the name the answer was already nothing and still is. The corpus pins both halves in one file.
`react/cards/OrderRowList.tsx` renders `<OrderRow />`, a package's component whose basename only
`react/types/OrderRow.ts` shares locally, and the filter is what stops that tag coupling the list to
a type module nobody rendered. The same file renders `<Total />` where `react/cards/Total.tsx` is a
`component` and `react/types/Total.ts` is a `module`, which is exactly the pair the filter-first
order would have resolved, and it produces **no edge**. This is also where piece 2 of the React work
pays for piece 3, and the two are not independent: without a `component` kind there is no kind to
name here, and the filter would have nothing to say.

**All three later changes to the strategy reach these two rules and nothing else in either shipped
pack**, since they are the only `short-name` rules pointed at a language that spells its components
one way and its files another. The case fold is what lets a `<CardFooter />` find `cardFooter.tsx` in
a file that imports it as such, which is how half the React repositories in the world name a
component file;
`declares` is what stops a
`<CardFooter />` in a file holding its own `const CardFooter = () => ...` finding that file at all;
`packages` is what stops a `<Button />` imported from `@mui/material` finding the local `Button.tsx`.
The php pack's `template` rule is reached by none of them in practice: a Blade tag is kebab-cased and
normalized into PascalCase before the index sees it, and PSR-4 makes the file's basename the class's
own spelling, so the exact map answers it and the fold is never asked. And php declares neither
`declares` patterns nor a `packages` block, so every name it reads is looked up exactly as it was
before any of the three fields existed.

**A bare opening `<Name>` is deliberately not matched, and this is the clause the measurement paid
for.** An opening-tag rule cannot be told apart from a TypeScript generic. Measured over the tracked
`.ts`, `.tsx`, `.js` and `.vue` files of this repository, 146 files with both fixture corpora
included and comments masked exactly as the pack declares them, the `.vue` override included: a
`<([A-Z][A-Za-z0-9_]*)[\s>]` rule fires **34
times**, and masking removes none of them, so raw and masked are both 34. **Thirty-one of the 34 are
generics** (`useState<Order>()`, `Array<Item>`, `<T extends Base>`, `const o = <Order>json`), and
outside the two fixture corpora all 24 hits are. The other three are real Vue component tags in
fixture SFCs, which is the rule working rather than misfiring: `Show.vue` naming `OrderTotal` in
`fixtures/acme-platform`, plus the pack corpus's `App.vue` naming `CartPanel` and `CartPanel.vue`
naming `CartLine`. That is why the ratio has to be quoted
with the file set it was taken over. Hardening it with a negative lookbehind still leaves the `.ts`
type-assertion and arrow-generic forms, so the rule was refused rather than narrowed. Nothing is lost
by it: every JSX element with children has a closing tag. A count quoted without its basis is a count
nobody can re-take, and this one drifted twice before it was written down with the file set above.

**The refusal was originally argued in part on "an edge rule cannot be scoped to an extension", and
that half of it is now untrue and does not change the answer.** `pathGlob` exists, so an opening-tag
rule could be scoped to `**/*.{tsx,jsx,vue}` today. It would not save it: a generic is written in a
`.tsx` as freely as in a `.ts`, `useState<Order>()` sits in the ordinary component file rather than
beside it, and the type-assertion and arrow-generic forms a lookbehind cannot separate are the ones a
`.tsx` also holds. That is reasoning and not a measurement, since the 34-hit count above was taken
over the whole file set and has not been retaken per extension. Anybody who wants the opening-tag
rule should retake it scoped before arguing from it.

`(?:\.[A-Za-z0-9_]+)*` sits outside the capture on purpose, so a dotted tag contributes its **head**:
`<Menu.Item />` and `</Tabs.Panel>` resolve to `Menu` and `Tabs`, which is the file that defines the
compound. `(?:<[^<>]*>)?` allows a generic component, `<Select<Option> value={v} />`, which would
otherwise fall out of the self-closing rule entirely.

**The prop class is `[^<]` and not `[^<>]`, and that is the clause a later reader is most likely to
"tighten".** Doing so breaks the common case rather than an edge case: `>` appears in almost every
real prop list (`onClick={() => save()}`, `count={n > 0}`), and `[^<>]` misses every tag carrying
one. The class is still bounded, because a closing tag contains `<`, so the scan stops at the next
tag rather than running to the end of the file. It crosses newlines deliberately, which is how a
multi-line self-closing tag matches at all, and the edge is reported on the line the tag opens.

`module-path` resolves a specifier against the file that wrote it, then tries, in order: the path
itself, the path plus each of the pack's `match.extensions` in declared order, and the path plus each
`indexNames` entry plus each extension. First hit wins, and only a hit that is already a node
becomes an edge. A specifier that is not relative (`react`, `@acme/ui`) names a package rather than a
file here and resolves to nothing, which is the same rule as everywhere else: a vendor import is not
a coupling this repository can break.

**The alias is the one bare-looking specifier that does name a file here**, and it used to be this
strategy's worst blind spot rather than a narrow one: a repository written in alias style produced no
edge for any aliased import, so a file half of whose importers reach it through `@/` read as barely
used. What decides an alias is a property of the repository and not of the language, so it is
answered by the root's `aliases` map in config ([03-config-schema](03-config-schema.md)) and by
nothing in the pack: a non-relative specifier is matched against that map before it is given up on,
the best-matching pattern is the only one tried, and a root that declares no map behaves exactly as
this strategy did before the field existed. An alias nobody wrote down still resolves to nothing,
which is what the review discipline's "read the absences" step expects. A workspace package name that
resolves through a `package.json` `workspaces` list and no alias map is still skipped.

Whatever the strategy, a capture that resolves to something the graph does not contain produces no
edge: a vendor import is not a coupling this repository can break.

`observer` has one known limit worth stating before a pack leans on it. It captures short class
names, not fully-qualified ones, so it maps each name to a node id through an index of names. When
two nodes share a short name that name is ambiguous, and the edge is skipped rather than guessed, so
a repository with an `OrderObserver` in two namespaces loses that edge. Guessing would put a wrong
`file:line` in front of a reader, which is worse than an absence the review discipline's "read the
absences" step is built to catch.

### 5. `produces` / `consumes`: the cross-language bridge

This is the level-2 mechanism from [01-architecture](01-architecture.md). Each rule captures a
symbol and maps captures to named parts (`method`, `path`, `name`). The engine builds a produced
table and a consumed table per symbol kind, applies the bridge's `normalize` from config, and
emits an inter-language edge for each match. A backend pack `produces` http-routes; a frontend
pack `consumes` them. Same symbol kind, opposite direction, and the bridge in config says which
roots to join.

`map` says which capture group is which part, not how the parts become one key, so two fields do
that: `key` is a template over the part names (`"{method} {path}"`, and with no `key` the parts are
joined by a single space in `map` order), and `normalize` lists per-part normalizers applied before
the key is assembled. These run inside the pack, before the bridge's `normalize` in config. They
exist because the engine has no way to know on its own that `post` and `POST`, or `/v1/orders` and
`v1/orders`, are the same route.

The normalizer vocabulary is engine-side and closed, shared with `edges.*.normalize`, and a pack
composes it in the order it lists:

| normalizer | does |
|------------|------|
| `upper` / `lower` | case-folds the whole value |
| `strip-leading-slash` | drops leading `/`, so `/v1/orders` and `v1/orders` are one route |
| `last-dot-segment` | everything after the last dot, so `forms.text-input` is `text-input`; a value with no dot is returned whole |
| `pascal-case` | capitalizes each `-` or `_` separated segment and drops the separators, so `text-input` is `TextInput` |
| `dot-to-slash` | every dot becomes a `/`, so the view name `orders.show` is the path `orders/show`; a value already written with slashes passes through |

`pascal-case` leaves the rest of every segment exactly as written rather than lowercasing and
rebuilding it, so a name that already arrives in PascalCase survives the trip instead of being
reassembled on a guess about where its internal word boundaries were.

A rule captures from the file's **source** with `pattern`, or from its **path** with `pathPattern`,
and declares exactly one of the two. The path form is for a symbol whose identity is where the file
sits rather than anything written inside it. An Inertia page is
`resources/js/.../Pages/Auth/Login.vue` on disk, and nothing in the file names "Auth/Login"; the
controller that renders it writes
`Inertia::render('Auth/Login')` in source. So the page `produces` its name from `pathPattern`
(`"(?:^|/)Pages/(.+)\\.(?:vue|tsx|jsx)$"` → `Auth/Login`) and the controller `consumes` it from
`pattern`, and the bridge joins the two. The extension alternation is what lets a React-Inertia
repository, whose pages are `.tsx` or `.jsx`, produce the symbol its php controller already consumes;
the join itself never sees an extension, since `engine/bridger.ts` matches symbol and key alone. A
`pathPattern` runs once over the path (a file has one identity, not one
per line), its groups feed `map`/`key`/`normalize` exactly as a source pattern's do, and the
produced ref anchors at line 1 because a produced symbol's line is never surfaced: a bridge edge is
evidenced at the consumer's call site.

A rule declares `key` or `keys`, never both. `keys` is a list of templates over the same parts, and
it exists for the construct that registers a family of symbols in one line: a Laravel
`Route::resource('orders', OrderController::class)` registers seven actions, which the pack spells
as eight templates. The two numbers differ for one reason: Laravel counts `update` as a single route
answering both `PUT` and `PATCH`, while a key here is one method and one path, so that one action is
two keys. Written as eight rules differing only in their template it is eight copies of one pattern
that nobody keeps in sync — a fix to the pattern lands in seven of them and the eighth goes on
reading the old spelling. Every ref a `keys` rule yields shares the match's line and its owners,
because they are one line of code, and citing seven of them somewhere else would be citing somewhere
they are not written.

What the eight templates cannot spell is the parameter Laravel derives by singularizing the resource
name: `orders` becomes `{order}` by a rule no regex holds. The php pack writes `*` in that segment
instead, which is the spelling `engine/bridger.ts`'s `collapseParams` lands every parameter on
anyway, so a produced `orders/*` and a consumed `orders/${id}` meet there exactly as a produced
`orders/{order}` would. On a bridge that has not enabled `collapseParams` neither spelling ever
matches, since a parameter written two ways in two languages is not one string; `*` is therefore no
worse there, and honest about what it knows, which is that a value goes in that segment and not what
it is called.

This is the single highest-leverage part of the pack. It is what lets `empo query` on a controller
report the mobile screen that calls it, or on a Vue page report the controller that renders it. It
is also, as written here, a mechanism that only ever fires when a human configured it, which is what
section 5c is about.

### 5b. `scopes`: what encloses a symbol

A symbol's key is assembled from what one line of source says, and for a route that is a lie the
framework tells. `Route::get('orders')` written in `routes/api.php` reads as `GET orders`, while the
application serves `/api/orders`, because the prefix is written somewhere else entirely: in the
`Route::prefix('api')->group(...)` the call sits inside, or in the `RouteServiceProvider` line that
loaded the file. The consumer, a fetch call in a frontend pack, writes the path the application
really serves, so the two keys never meet and the bridge that section 5 calls the highest-leverage
part of the pack silently produces nothing for every prefixed route in the repository. That is the
worst failure shape this document has: not a wrong edge but a missing one, in a family that looked
like it was working because the unprefixed routes still joined.

`scopes` is an optional top-level block, a list of rules that say what an enclosing construct
contributes and how far it reaches. A rule declares a `name`, the handle a `scopedBy` refers to; a
`pattern`; a `value`, the 1-based capture group holding the string this scope contributes; and an
`extent`. **Several rules may share one `name`**, and that is the ordinary case rather than an
allowance: one construct in one language is usually spelled two or three ways, and a prefix is a
prefix whichever spelling declared it. Naming the two Laravel spellings `route-prefix` twice is
what lets the rules that read a route name one thing and get both.

On the other side, a `produces` or `consumes` rule may carry **`scopedBy`**, three fields and all
three required when the field is present: `name` picks the scope, `part` names which part of `map`
the value is joined onto, and `join` is the string that joins them. `join` has **no default**, which
is the same refusal `indexNames` makes one section up. A scope is not always a path: a namespace
joins on the language's own separator, a route name joins on a dot, a queue name on a colon. A
default of `/` would let a pack stay silent and the engine guess at a language, and guessing at a
language in the engine is the one thing this contract exists to prevent.

**`balanced` is textual enclosure and nothing more.** The extent runs from the match to the
delimiter that balances the first `open` after it, counted by the same walk section 7 already uses
for a transaction (`balancedEnd` in `engine/hazards.ts`), and every symbol whose own match falls
inside that extent takes the value. Reusing the walk is deliberate: two ways of asking "where does
this construct end" would be a defect invisible from either pack. What a scope does not reuse is the
view those delimiters are counted over, and the end of this section says why: an unmatched delimiter
inside a string literal ends a transaction's extent early, and a scope's it cannot, because a scope
counts on the string-blanked view. Scopes nest, and nested values compose from the outside in, so a
group inside a group reads as the outer prefix then the inner one, which is the order a reader of
the file would assemble them in.

**`file` is enclosure by reference, and it is the half a textual rule cannot reach.** The match
names a *different* file, in the capture group `file` points at, spelled the way the language spells
it, which is relative to the root and not to the repository; everything that file produces takes the
value. A `RouteServiceProvider` writes the prefix and the filename on one line and the routes
themselves are a directory away, so no walk over the provider's own text could ever find them. This runs as a pass over the root's scanned files before the symbol rules
read any of them, because the value has to exist before the file it covers is keyed.

The part's own `normalize` list applies to a scope value exactly as it applies to a captured one,
and it applies before anything is joined. Otherwise `strip-leading-slash` would run on the assembled
string and leave a `/api` prefix's slash sitting in the middle of the key, which is the shape of bug
the normalizers exist to end rather than to relocate. Joining then trims the `join` string off both
seams, so `api/` and `/orders` read as `api/orders` and not as `api//orders`. That is the one piece
of tidying the engine does on a pack's behalf, and it earns its place because the two halves are
written by different hands in different files and neither can see how the other spelled its edges.

Five shapes are **refused at load**, for the reason every other refusal in this contract is: each
one produces a silence a user would have to go hunting for, and the message can name the pack.
A `balanced` rule with no `open`/`close` pair has no way to find its end, and a walk with nothing to
count would enclose the whole file and stamp its value onto every symbol in it. A `file` rule with
no `file` group names no file and covers nothing, forever. A `value` or a `file` naming a capture
group the pattern does not have yields an empty string, and an empty prefix is exactly the
un-prefixed key this block exists to correct, arrived at through a rule that looks like it works. A
`scopedBy` naming a `part` that is not in `map` has nowhere to put its value, and a `scopedBy`
naming a scope no rule in the pack declares contributes nothing for the life of the pack, which
reads at the far end as a bridge that found no match rather than as a pack that named a scope that
does not exist.

A `file` scope follows the whole chain and not its last link. A file that names another may itself
have been named, and what it passes on is then everything it carries: Laravel 11 mounts
`routes/v2.php` under `v2` from `bootstrap/app.php`, `routes/v2.php` mounts `routes/v2_admin.php`
under `admin`, and a route in the admin file answers `/v2/admin/…`. A resolver stopping at one link
keys it `admin/…`, which is the same defect this block exists to fix, one level further out, and
just as well-formed. Where the chain closes on itself the file is given no scope at all rather than
some finite reading of a loop: a cycle has no outermost segment to start from, so which segment a
finite answer drops depends only on which file the resolver reached first, and answering with
nothing is the one reading that invents no URL.

**What it cannot do, and the boundary is a root.** The reference is spelled root-relative, because
that is how the language spells it — Laravel's `base_path('routes/api.php')` is relative to the
application and the application is the root — so the pass resolves it against the naming file's own
root: the same line read in a root of `apps/api` names `apps/api/routes/api.php`, which is the
repo-relative spelling the rest of the engine keys files by. A root of `.` leaves nothing to put
back, which is why every fixture reads the same either way. What the pass will not do is leave the
root it read the reference in: only files that root scanned are ever looked up, so a provider in
root A naming a route file in root B is not seen, the routes in B keep their unprefixed keys, and
nothing says so. That is the same boundary `module-path` already draws for an import, but it is
worth stating separately here because the provider shape invites the crossing: a monorepo that keeps
its application code and its route files in two roots is not exotic. Both extents also inherit
everything section 3 says about masking: comments are blanked, so a commented-out group opens no
scope, and string literals are not, so a `Route::prefix(` written inside a heredoc or a fixture
opens one that is not real and prefixes every route below it.

Where a `balanced` extent parts company with section 3 is in the counting. The pattern is matched
over the view that still has its strings, because the value a scope contributes is written in one —
`'prefix' => 'api'` is a string literal and there is nothing to capture without it — but the
delimiters are counted over the string-blanked view. That asymmetry is not tidiness. A brace inside
a string is the one thing that can silently shorten a scope, and shortening it is worse than
lengthening it: the routes that fall out of the extent keep well-formed keys that are short by a
segment, so nothing anywhere looks wrong. It was measured, on a route file that wrote
`Route::post('bookings/{booking}/print}', …)`, one stray brace in a URL, which closed the enclosing
group sixty routes early.

And the whole block is enclosure the pack can *see*. A prefix assembled at runtime, read from
config, or applied by middleware the routes never name is invisible here exactly as a dispatch
reached through a helper is invisible to section 7. A key that comes out unprefixed has not been
proved unprefixed; it has been proved to sit inside no construct a pack rule matched.

### 5c. `joins`: both halves written in one language

Section 5 describes how a produced table and a consumed table are matched, and leaves implicit the
thing that decides whether they are matched at all. Until this field existed that thing was always
the same: a `bridge` in the user's `.empo/config.json`. `engine/bridger.ts` runs once per configured
bridge and never otherwise (`engine/graph.ts`), so a symbol kind no bridge names is matched by
nobody, however completely both tables were filled. And a bridge is the one part of the config `empo
init` refuses to guess, because it is a claim only a person can make — that two roots somebody
deliberately kept apart really do exchange this symbol, under a normalization only they know. Init
does not even mention the gap unless the repository holds two or more languages
(`commands/init.ts`). So in a single-language repository the two tables were built, deduplicated,
written into `graph.json`, and never introduced to each other. A pack could produce a symbol on one
line and consume it forty lines away in its own dialect, and the graph would say nothing, forever,
without a word of warning — the shape section 5b already names as the worst failure this document
has: not a wrong answer, a missing one that looks like a clean bill of health.

`joins` is a top-level list of symbol kinds (`string[]`, default `[]`) whose two halves are written
in one language and matched inside one root. `engine/graph.ts` `packJoins` turns each declared kind
into one synthetic bridge per root that speaks that language, with `produces` and `consumes` both
set to that root's own path, and appends those to `config.bridges` before `bridgeRoots` runs. The
matcher needs no change to accept them: it compares each node's root against a set of root paths and
never asks whether the two sides are different roots, and it already refuses an edge from a node to
itself. Appended and not merged, because `empo doctor` prints a match rate per bridge, and a config
bridge and a pack join are two different claims about one symbol kind — folded together they would
report one rate over two populations that were never one question. `empo doctor` prints the pack's
own joins beside the configured bridges for the same reason (`engine/health.ts`).

There is deliberately no `normalize` on a pack join. A config bridge needs one because its two sides
were written by different people in different languages, and nothing but a human knows that `post`
and `POST` are one method. Both halves of a join come out of one pack, which has already normalized
them on its own symbol rules, so a second normalization here would be a second place to keep in sync
with the first.

**It is opt-in per kind, and it is emphatically not "every symbol a pack writes both halves of".**
That rule is available, it needs no field at all, and it is wrong. The php pack produces
`http-route` from the route files and consumes it from its own feature tests, which is exactly what
makes `empo query` able to say a route is exercised. Joining that kind inside a root would hand
every route in the repository a fan-in edge from the test that calls it, and every number this tool
prints about that route would move — not because anything about the code changed, but because a
default did. A field somebody has to type per kind is the difference between an edge that was asked
for and an edge that arrived.

`src/schema/pack.schema.ts` refuses at load a `joins` entry this pack does not both produce and
consume, and the message names which half is missing (`joins "x", which this pack only produces: a
join needs both halves`) or says no rule writes the kind at all. The failure it prevents is silent
in precisely the way the section above describes: a join whose counterpart table is empty runs,
matches nothing, and leaves a graph indistinguishable from a repository where nothing is scheduled.
A kind named here is a claim that both halves exist in this pack, so it is checked while the person
who typed the name is still looking at it.

The php pack declares one: `scheduled-command`. The command class produces the symbol from
`protected $signature = '…'`, with an optional `static` and `string` in front of it, and from the
`#[AsCommand(…)]` attribute, which is the same declaration in the spelling newer Laravel prefers.
Two rules read the attribute rather than one, because PHP gives it more than one legal shape: the
name is the first argument or a named `name:` one, named arguments are order-independent so
`AsCommand(description: '…', name: '…')` is as ordinary as the other order, the attribute may be
written fully qualified, and several attributes may share one `#[]`. A rule anchored on the literal
`#[AsCommand(name:` reads the one spelling its author happened to have in front of them and misses
the rest silently, which is this section's recurring failure. **`protected` and not every
visibility**, which was tried and reverted: an Artisan command
overrides `Command::$signature`, which is protected, so the wider rule found nothing new on the
command side, while `private $signature` and `public $signature` are what a webhook HMAC verifier
and a signed-payload DTO call their own field. The narrower rule keeps a distinction the wider one
spent for nothing.

`app/Console/Kernel.php` consumes the symbol from `$schedule->command('…')`, from a schedule held as
a property (`$this->schedule->command('…')`), and from the `Schedule::command(` facade spelling,
since the framework offers all of these and a rule that knew one would drop the rest of any schedule
that mixes them. Every branch is anchored on a receiver that is a schedule rather than on
`->command(` alone, because `->command(` is an ordinary method name: a process builder writing
`$process->command('ls -la')` would otherwise consume a symbol named `ls`, and a phantom consumed key
is worse than a missing one — it is counted against the join's match rate and sends whoever reads
`empo doctor` looking for a command nobody ever scheduled. The receiver is also all a regex has to
go on, so the one spelling that falls out is a short parameter name: `function schedule(Schedule $s)`
followed by `$s->command('…')` names its schedule only in the type hint, which is nowhere near the
call site.

Both sides key on the leading token, up to the first whitespace or `{`, which is not a tidiness
choice: a signature carries its arguments and options in the same string (`orders:reconcile {club?}
{--force}`) while the scheduler names the command alone, so keying on the whole literal would match
nothing on every command that takes an argument, which is most of the interesting ones.

`Schedule::command(ReconcileCommand::class)` takes no part in this join and does not need to. That
form names the class, and a file naming a class imports it, so level 1 has already drawn the edge
from the scheduler to the command through the `use` line at the top of the file. The join exists for
the other spelling, the one where the only thing written down anywhere is a string.

**Which side produces and which consumes is load-bearing, not a naming convention.** A bridge edge
runs from the consumer to the producer, the same direction an import runs, and it is evidenced at
the consumer's call site (`engine/bridger.ts`). The definition side must therefore be the `produces`
side. Written the other way round the edge points from the command class at the scheduler, and the
fan-in this join exists to create lands on `Kernel.php` — which already had plenty — instead of on
the command, which had none.

Which is what the field buys. A scheduled command is a class nobody calls: no controller constructs
it, no service imports it, its name appears once in the repository as a string in a scheduler entry.
Before this join, a diff touching that command file read as a leaf with a fan-in of zero — the shape
`empo review` treats as the safest thing in the change — while it was in fact the thing that runs
every night against production data.

### 6. `tests`: coverage

The engine needs to answer "does any test assert on what this code produces." A pack declares
where tests live and which tokens count as a real assertion. `assertionTerms` is what separates a
test that asserts a value from a test that only asserts HTTP 200. The spine layer
([08-spines](08-spines.md)) refines this per spine (a money spine wants assertions on amounts in
cents), but the pack sets the language-wide default.

**A test reaches code along every edge family, not just `import`.** Coverage walks out of a test
node along every edge that is not a cross-root bridge (`engine/coverage.ts`), so `fqcn`, `string`,
`template`, `hook` and `inherit` edges carry a test to its subject exactly as `import` edges do. That
is deliberate and it is the more useful reading: a test naming a class in a string couples to it as
hard as one importing it, and a pack cannot narrow coverage to one family.

A `tests.paths` entry is a directory prefix (`tests/`) or a glob (`**/*.test.ts`), decided by whether
it holds a glob character. Both conventions are real and a pack should not have to pick: PHP puts its
tests in one tree, TypeScript colocates `OrderScreen.test.tsx` beside the file it tests, and a
prefix list cannot see the second. A pack that lists only directories behaves exactly as before.
The glob list has to keep pace with `match.extensions`, which is why the typescript pack carries one
per JavaScript dialect (`**/*.test.js`, `.jsx`, `.mjs`, `.cjs`) beside the two TypeScript ones: an
extension added to `match` and not to `tests.paths` makes every test file written in it read as
production code.

`assertionTerms` are substrings of the masked source, so write the opening parenthesis into them.
`toBe(` is an assertion on a value and `toBeDefined(` is not, and only the parenthesis tells them
apart. Leave the parenthesis off only to absorb a family deliberately: `assertEquals` also catches
`assertEqualsWithDelta` and `assertEqualsCanonicalizing`, and no sibling of that prefix is a
non-value assertion. Check that before dropping one, because `->toHaveKey` would swallow
`toHaveKeys` harmlessly and `->toBe` would swallow `toBeDefined(`, which is the trap above.

**`assertionExcludes` is for the term no parenthesis can rescue.** `assertTrue(` is a value assertion
in `assertTrue($order->isPaid())` and a liveness assertion in
`assertTrue(method_exists($c, 'confirm'))`, and no substring of the term separates them, because what
decides it is the argument. Dropping the term loses every real value assertion written with it, and
keeping it unqualified re-admits exactly the family this section exists to exclude. So a pack names
the liveness spellings instead: every occurrence of an `assertionExcludes` entry is removed from the
masked source before a single `assertionTerms` match runs, and both answers come out right. Removal
rather than matching around is deliberate, so that a term sitting inside an excluded call cannot
qualify the file by some other route either.

**Naming the spellings only works if the family is named completely, and one half of that is
derivable.** A language that lets a pack name a declaration usually offers a reflection predicate for
each kind of declaration it has, so the reflection entries in `assertionExcludes` must cover every
declaration keyword the pack's own `namePattern` names, in the affirmative and the negative spelling
both: `assertFalse(class_exists(` claims no more about a value than `assertTrue(class_exists(` does.
The php pack left `trait_exists(` and `enum_exists(` out while listing their siblings, and `trait` and
`enum` sit next to `class` in the very pattern its node ids are read from, so a test asserting only
that an enum exists scored its file as asserting a value. What closes that is mechanical rather than a
matter of remembering: read the declaration keywords off `namePattern` and require an entry per
keyword per spelling, which is what the php pack's spec does, so a keyword added to that pattern with
no matching exclusion comes back red instead of quietly widening what counts as an assertion. The rest
of the family asks about a member, a function or a callable rather than about a declaration
(`method_exists(`, `property_exists(`, `function_exists(`, `is_callable(`), nothing derives it, and it
is pinned as a written-down set for exactly that reason.

Its limit is worth stating plainly, because a pack leaning on the field should know which half of the
problem it bought. An exclusion is a literal substring and nothing more, so it only reaches a
disqualifier written adjacent to the term. `assertTrue(method_exists(` is one string and can be
named. Pest's `expect(method_exists($c, 'confirm'))->toBeTrue()` cannot be: the predicate sits inside
`expect(`, the term that matches is `->toBeTrue(`, and the subject sits between them, so no literal
covers the pair. That file still scores as asserting a value when it asserts only that a method
exists. Expressing it would take a pattern rather than a substring, and the field is a substring list
until a corpus argues otherwise.

A second residue has the same shape aimed the other way, and it belongs beside the first rather than
in a bug list. `assertTrue($found instanceof Order)` keeps the `assertTrue(` term and so scores the
file as asserting a value, while `assertInstanceOf(Order::class, $found)` makes the identical claim
and is deliberately not a term at all, because proving a shape is not proving a number. The two
spellings of one assertion should agree and do not. No exclusion closes it either, for the reason
above: the subject sits between the term and the predicate, so there is no adjacent literal to name.
Both residues are the honest price of a substring field, and a pack leaning on it should read them as
the boundary of what it bought: `assertionExcludes` reaches the disqualifier written next to the
term, and nothing further.

**A term is checked against the surface a test file inherits, not only against the method the author
had in mind.** `assertJson(` went into the php pack for Laravel's
`$response->assertJson(['total_cents' => 1250])`, which claims a number. Written bare it also matches
`$this->assertJson($response->getContent())`, and that is a different method:
`PHPUnit\Framework\Assert::assertJson(string $actual)` is final, static, takes one argument, and
asserts only that the string parses as JSON. Every Laravel test class extends PHPUnit's `TestCase`,
so the whole of that class is in scope in every file the pack reads, reachable as `$this->`, `self::`,
`static::`, `parent::` and by a class name, aliased or not. Well-formedness is a weaker claim than
`->assertJsonStructure(`, which this section deliberately keeps out, so the bare term qualified a
file on less than the spelling next to it was written to refuse.

Unlike the two residues above, this one is at least reachable: the receiver sits immediately left of
the term, so `$this->assertJson(` is a literal an exclusion can name, and no receiver the pack
subtracts is a substring of `$response->assertJson(`. Reachable is not closed. An exclusion removes
the literal spellings it names and nothing else, so the pack names the four receivers whose spelling
PHP fixes (`$this->`, `self::`, `static::`, `parent::`) and the declaring class (`Assert::`, which
subtracts the fully-qualified `\PHPUnit\Framework\Assert::assertJson(` for free, because that string
ends in the one being named). What escapes is every spelling whose receiver is an identifier somebody
chose. `use PHPUnit\Framework\Assert as A;` makes `A::assertJson(` the same call under a name no pack
can predict; a project's own base class does the same for `ApiTestCase::assertJson(`; and importing
the function wrapper with `use function PHPUnit\Framework\assertJson;` leaves no receiver to anchor
on at all. Each of those still scores its file as asserting a value while it asserts only that a
string parses. So this residue is narrowed by naming receivers, not closed, and that is the
difference between a list that can be finished and one where the next entry is always available and
never the last.

Two things follow for whoever adds the next term. A receiver-agnostic exclusion
(`assertTrue(method_exists(`) gets every receiver for free, while a receiver-anchored one gets
exactly the receivers it wrote down, so the second kind buys a narrowing and never a fix. And the
thing to look for before adding a term at all is an inherited homonym of different arity, because the
surface a test file inherits is the surface the term is matched against whatever the author had in
mind.

**A term list is per language, and one language usually has more than one test framework.** The php
pack's first list was PHPUnit-only, and on a Laravel repository written in Pest it marked 15 of
409 test files as asserting a value, of which 14 qualified solely through `->assertStatus`, the very
"only asserts HTTP 200" case the paragraph above excludes, and the fifteenth was a helper. So under
this doc's own definition the honest count was **zero of 409**, and every flow in that repository
would have been reported covered on the strength of tests that check nothing. A pack owns both
dialects or it owns neither: `assertSame(` and `expect($x)->toBe(` make the same claim, and which one
a file uses says nothing about whether it checked a value.

The same reasoning settles the argument about a rendered-output assertion. `->assertSee('total: 12.50')`
and `expect($html)->toContain('total: 12.50')` are one assertion in two spellings, so a list that
takes the second and refuses the first is not a rule about assertions but a rule about which
framework the author reached for. Both read what the code computed, which is the side of the line
this section draws. `->assertOk()` reads what the framework computed, and stays out.

`->assertInertia(` is decided the other way, and for a reason about reach rather than about
spelling. The term itself claims only that the response is an Inertia response, which is the
framework's own bookkeeping and not a value the code computed. The value claim is one level down,
inside the closure the call takes, at `->where('total', 12.50)` and `->has('orders', 3)`, and a
substring matcher cannot follow it there: the term list is matched against the file's text with no
notion of which call a line sits inside. Taking the outer term would qualify every file that renders
a page at all, including one whose closure asserts nothing. Taking `->where(` instead is worse rather
than better, because Eloquent spells its query builder the same way, so ordinary setup code in a test
that checks nothing would score the file. Neither the term that is reachable nor the term that is
precise is both, so the pack takes neither, and a Laravel test whose only assertion is an Inertia
closure reads as not asserting a value. That is the conservative direction of the two: this field
exists to keep a flow from reading as covered on the strength of a test that checked nothing.

**The rule binds every pack, and the pack that stated it was the second one to obey it.** The
typescript pack sat at four jest/vitest matchers (`toBe(`, `toEqual(`, `toStrictEqual(`,
`toHaveBeenCalledWith(`) while the language it owns has three test dialects in common use, and the
other two were worth nothing to it: a repository testing with `node:assert`, which ships with the
runtime and needs no dependency at all, or with chai, had every one of its test files score as
asserting nothing. Measured on a throwaway repository, a flow whose only test reads
`strictEqual(checkout(1250), "Total 12.50")` was reported **BLIND**. The list now spans all three,
and the shape of each dialect decides the spelling. Jest and vitest matchers are called, so they
carry the opening parenthesis, with the two deliberate exceptions the paragraph above licenses:
`toBeGreaterThan` and `toBeLessThan` are bare, to absorb the `OrEqual` siblings, and every sibling
they absorb is a value assertion. `node:assert` is usually destructured (`strictEqual(`,
`deepStrictEqual(`) and sometimes not (`assert.match(`), so both forms are named, and only the forms
whose bare spelling is distinctive are taken bare, because `equal(`, `match(`, `ok(` and `throws(`
are ordinary words that appear in a test file for other reasons.

**Chai is matched on the tail of its chain rather than on the head, and that is the one piece of
cleverness in the list.** One chai assertion has four spellings, `.to.equal(`, `.to.not.equal(`,
`.not.to.equal(` and `.should.equal(`, and the negated form is the one chai's own documentation
writes. A term anchored on the head takes one of the four, so a suite written in negative assertions
scores entirely blind while looking covered to whoever wrote the list. `.equal(` takes all four in
one term, and `.be.true` does the same for the property assertions, which have no parenthesis
anywhere in them. The one tail that cannot be used is `.match(`, because `String.prototype.match` is
in every other file of the language, so that one is spelled by its heads (`.to.match(`,
`.should.match(`, `.not.match(`). A tail term also picks up `assert.equal(` for free, which is why
the `node:assert` list does not name it.

**Widening the list found the more dangerous defect underneath it, in the other direction.**
`expect(typeof createOrder).toBe("function")` is the JavaScript spelling of `assertTrue(method_exists(`:
it checks that an export exists and never looks at anything the code computed, and it matched `toBe(`
like any real assertion, so a flow whose only test was that line read as **covered**. That is the
false-comfort direction, which this field exists to refuse. The typescript pack therefore declares
`assertionExcludes` for the first time, naming the `toBe` and `toEqual` forms in all three quote
spellings the language has.

**This is the first exclusion in any pack that names a whole argument rather than stopping at an
opening parenthesis, and the difference costs something.** `assertTrue(method_exists(` is immune to
how its argument is written; `toBe("function")` is not. A formatter that wraps the call past its
print width, or interior whitespace, leaves the term matching and the file scoring as asserting, with
the meaning unchanged. So the answer moves with line length, which is a worse property than the usual
"an exclusion narrows and never fixes", and it is pinned as data in `test/packs/typescript.test.ts`
rather than left in prose here. Two other limits are inherited from PHP's: what no exclusion can
reach is `expect(mod.helper).toBeTruthy()`, where the liveness claim sits in the receiver rather than
adjacent to the term, and a genuine assertion is lost where a factory really does return a function,
which is the conservative direction of the two.

**The truthy family is left out entirely, and this is where the typescript pack parts company with
the php one on purpose.** php takes `assertTrue(` and names the liveness spellings in
`assertionExcludes`, and that works because PHP puts the argument *inside* the term. JavaScript puts
it on the left, so `expect(mod.helper).toBeTruthy()` and `expect(isPaid(order)).toBeTruthy()` differ
only in text no exclusion can anchor on. A term that is neither reachable nor precise is one the pack
takes neither way, which is the rule this section already drew for `->assertInertia(`. So
`toBeTruthy(`, `toBeFalsy(` and `assert.ok(` are out, and a suite written entirely in them scores
blind, which is the direction to fail in. **The call shape of the language decides the term list, not
the shape of the list the other pack ended up with.**

Four more families are left out, each for a reason already drawn above rather than for taste.
`toBeDefined(` and `toBeUndefined(` are the presence family, which is the trap the parenthesis
rule is written around. `toBeInstanceOf(` proves a shape rather than a number, exactly as
`assertInstanceOf(` does. `toHaveProperty(` and chai's `.to.have.property(` change meaning with their
arity, one argument asking whether a key exists and two asking what it holds, and no substring tells
those apart. `toHaveBeenCalled(` says a mock ran and nothing about what it was given, where
`toHaveBeenCalledWith(` and `toHaveBeenCalledTimes(` both carry a value.

**`tests.paths` grew with the term list, and forgetting it is how the whole widening comes to
nothing.** The rule is the one stated for `match.extensions` above, one level over: a dialect whose
naming convention the pack does not know is a dialect whose terms are never consulted, because terms
are only ever matched against a file already classified as a test. mocha keeps its suite in `test/`
singular, jest defaults to `__tests__/` where files are often not named `.test.` at all, and every
Jasmine-descended runner writes `*.spec.ts`. None of those was matched while all three dialects were
in the term list, which is exactly the shape of the `.js` gap this document already records. The
failure is also the worse of the two directions available: an unrecognized spec file is not merely
invisible, it is **production code** in the graph: it consumes the module it tests like any other
caller, and the flow that holds it reads as reached by no test at all. Measured through the built
bundle on a throwaway repository, the same file moved a flow from `no test reaches this flow at all`
to `covered`, and the denominator from `0 are reached by a test` to `1 is reached`. The fan-in count
itself does not move, which is worth stating because it is the number somebody would check: the file
is a consumer either way, and what changes is whether anything knows it is a test.

### 7. `hazards`: the optional transaction axis, and the loop axis beside it

The hazard is one specific thing: a queued job dispatched from inside a database transaction without
waiting for the commit. The queue does not roll back with the database, so a worker can pick the job
up and run it before the rows it needs are committed ([13-glossary](13-glossary.md)). It is a class
of defect that reads as correct in the diff, because the dispatch and the transaction are usually
written by different hands at different times, and both lines are ordinary.

**The block is optional, and the option carries a claim.** A pack that declares no `hazards` block
says this language has no such hazard worth looking for; a pack that declares one and finds nothing
says this code is clean. The line is drawn at the key and not at its contents, so a block that is
present and empty is the second answer and not the first: it compiles to rules that find nothing,
which is what a pack says when it looks and comes back with nothing. Those are different answers and
`empo query --hazards` prints them
differently ([06-cli](06-cli.md)), which is the same rule the graph already applies to a flow that
matches no node ([05-graph-model](05-graph-model.md)): an empty result is a fact worth seeing and an
absent one is not the same fact.

Seven fields, and every string in all seven is a marker the engine walks rather than a language the
engine knows:

- **`transactions`** is a list of `{ pattern, extent }`, where `extent` says how to find where the
  transaction ends once `pattern` matched. Two forms, because the two ways to open a transaction are
  structurally different and neither expresses the other. `balanced` is the closure form
  (`DB::transaction(function () { … })`): the extent runs from the match to the delimiter that
  balances the first `open` after it, so the rule also declares the `open`/`close` pair to count.
  `span` is the manual begin/commit form (`DB::beginTransaction() … DB::commit()`): the extent runs
  to the next `endPattern` match, and to the end of the file when none arrives, because a transaction
  nothing closes is the worse hazard rather than a reason to report nothing. A `balanced` extent runs
  to the end of the file in two cases for that same reason: when the delimiters never balance, and
  when no `open` delimiter follows the opener at all. A `balanced` pattern must therefore match
  only the spelling whose `open` delimiter really follows it, which is why the php pack spends two
  `balanced` rules on one keyword: the closure rule requires the `function` keyword and balances
  `{`/`}`, and the arrow-function rule matches `transaction` with a lookahead for `(\s*fn`, with the
  `static` of `static fn` optional in the lookahead exactly as it is in the closure rule, and
  balances `(`/`)` instead, because `fn () => …` opens no block and a brace-counting walker would
  balance the next unrelated block instead. The delimiter pair is per-rule for exactly this reason.
  A `balanced` extent counts delimiters in text whose string literals are not masked, so it inherits
  the string-literal blind spot: an unmatched `)` inside a string ends a paren-balanced extent early,
  and an unmatched `(` extends it to the first `)` that balances the surplus, which is the end of the
  file when no later `)` restores the depth. An arrow body is a single expression, so the common
  miscount ends the extent early rather than late; the late case is unbounded all the same, and one
  stray `(` in a string can enclose every dispatch below it.
- **`loops`** is a list of the same `{ pattern, extent }` shape, with the same two forms, compiled
  by the same `compileExtentRules` and walked by the same `enclosedBy` as the field above it,
  because "what does this construct enclose" is one question whatever opened it. What it asks is a
  different question, and the paragraphs after this list are about keeping the two apart.
- **`transient`** is that same `{ pattern, extent }` shape a third time, and the third pairing of
  the same walk. Its openers name a **kind of error** rather than a construct: a `catch` of something
  the ecosystem spells as temporary. That is a heuristic and the pack states it as a list a reader
  can check — the php pack names `RateLimit`, `Throttl`, `TooManyRequests`, `Timeout`, `Transient`
  and `Temporar` — so a codebase that calls its own retryable error something else gets nothing here
  and can see exactly why. The brace is a lookahead for the reason every loop rule's is, and the
  regression it buys off is the same one: a pattern that ate the body's brace would balance the next
  unrelated block and report every `fail()` below it as a rate-limit fail.
- **`dispatches`** is a list of `{ pattern, job }`, where `job` is the 1-based capture group holding
  the dispatched job's name. It is a group number and not a convention, because a language spells the
  dispatch two or three ways and the name does not sit in the same place in all of them. Two rules
  that both describe one call site produce one hazard and not two.
- **`permanentFailures`** is the same `{ pattern, job }` shape, and the first site family that is
  not a dispatch: what records a failure as final, which in Laravel is `fail()` on a queued job. It
  is matched inside `transient` exactly as a dispatch is matched inside a transaction, and on its own
  it means nothing at all — a job with no other arrangement *should* fail on a rate limit. Inside a
  catch of an error the caller was told would pass, it says the two halves disagree. Whether that is
  a defect turns on what else the handler did, and no rule here can see an arrangement made in
  another file, so the axis prints the coordinate and stops, the same bargain `loops` makes about
  cardinality.
- **`deferAtSite`** are patterns matched against the dispatch's own **statement**, which is the text
  from the dispatch to the first `;` after it that is not inside a string literal, or to the end of
  its line when the rest of the file holds no such `;`. The statement and not the line, because the
  chained spelling puts the deferral on the next line (`dispatch(new Foo)` then `->afterCommit();`)
  and a line-bounded rule would report a hazard the code already handles. The statement and not the
  file, because one marker further down would otherwise silence every dispatch above it. A language
  with no statement terminator should carry its deferral in the field below, which asks a whole-file
  question and needs no boundary. The string-literal exception is read from this pack's own
  `comments.stringQuotes` and `stringEscape`, so a pack that declares no comment syntax gets the
  plain scan.
- **`deferAtDeclaration`** are patterns matched against the whole source of the file that declares the
  dispatched job: every dispatch of that job waits, wherever it is written. The two exist separately
  because a language offers both, and collapsing them would make a per-call deferral silence a class,
  or a per-class deferral silence only the one call. This half can only apply once the job resolves to
  a node, so a job named through a variable is never deferred by declaration and stays on the list,
  which is the conservative direction.

`src/schema/pack.schema.ts` checks what a reader of the pack would otherwise have to notice: a
`balanced` rule with no `open`/`close` pair, a `span` rule with no `endPattern`, and a `job` naming a
capture group its pattern does not have. Each of those failures **invents** hazards rather than
missing them (a `balanced` rule that counts nothing encloses every dispatch in the file, a `span`
rule with no end runs to the bottom of it), and inventing is the direction this tool may not fail in,
so all three fail at load where the message can name the pack. The engine holds the same line a
second time rather than trusting the schema: a transaction rule that reaches it without the companion
its `extent` requires is dropped whole rather than half-applied, so the unreachable case reports
nothing instead of reporting everything.

**This is not a language leaking into the engine, and the reason is worth stating because it looks
like one.** `engine/hazards.ts` counts delimiters and compares character offsets; it has no idea what
a transaction or a queue is, and no language name appears in it. That is exactly the split
`engine/mask.ts` already makes for comments, where a pack names `//` and `/* */` and the engine walks
them. A pack naming `DB::transaction(` is the same kind of statement as a pack naming `//`.

**`loops` shares the walk and shares nothing else, and the separation is the design.** A dispatch
inside a transaction is a defect: the queue does not roll back, and a worker can beat the commit. A
dispatch inside a loop is not wrong at all — it is how a batch is written, and a rule that called it
a finding would be wrong on nearly every match it made. So the results never mix.
`engine/hazards.ts` exposes `findLoopedDispatches` beside `findEnclosedDispatches`, the sites it
returns land in `Graph.fanout` and never in `Graph.hazards`, and they carry a `loopLine` rather than
a `transactionLine`. Nothing subtracts a deferral there either: `deferAtSite` and
`deferAtDeclaration` answer "does this dispatch wait for the commit", which is a question this axis
never asked, so an `afterCommit` on a dispatch inside a loop changes nothing about it and the
`LoopedDispatch` record deliberately carries no field for it. A field in `graph.json` that no reader
of an axis can act on is worse than a missing one: somebody will act on it anyway.

The php pack declares four rules for it. Two are the keyword loops, each guarded by a lookbehind so
a keyword sitting at the end of a longer identifier (`$stepsfor (…)`) opens nothing: `foreach` and
`while` together, and `for` on its own, because a `for` header holds semicolons and the other two
never do, so one pattern bounding the header cannot serve both. Two are the collection callbacks —
`->each`, `->eachById`, `->map`, `->chunk`, `->chunkById`, `->chunkMap`, in the `->` and `::`
spellings, with the leading size argument of `chunk(100, …)` optional — one rule for the `function`
callback, `static function` included, balancing `{`/`}`, and one for the `fn` callback, balancing
`(`/`)` for the reason the arrow form of `DB::transaction` does above: `fn () => …` opens no block,
and a brace-counting walk would balance the next unrelated block instead.

**Both keyword rules require a `{` to follow the header, and they require it through a lookahead —
`\)\s*(?=\{)` and not `\)\s*\{`. That distinction is the subtlest line in this block and it is
load-bearing twice over.** `balancedEnd` starts looking for its `open` delimiter at the *end* of the
match, so a pattern that eats the body's own brace has already stepped past it: the walk then finds
the next unrelated `{` in the file and balances that instead, or finds none and runs the extent to
the end of the file, which reports every dispatch below as looped. The brace is a condition on the
opener and not a part of it, and the two spellings differ in nothing else, which is exactly what
makes the wrong one survive review. It survived one here. The whole suite stayed green while the
rules ate the brace, because no test held a dispatch written after a loop had closed; the test that
would have failed (`a dispatch after the loop closes is not in it`) exists now.

Requiring the brace at all is the other half of the argument, and it buys off three ordinary
spellings that would otherwise open an extent nothing ever closes: the alternative
`foreach (…): … endforeach;` syntax, `do { … } while (…);`, whose `while` sits after its block
rather than before one, and a loop whose body is a single unbraced statement. All three now match
nothing.

What that costs is paid in the direction this axis must fail in, and it costs three shapes. A loop
with an unbraced body (`foreach ($a as $b) Sync::dispatch($b);`) is missed. A `foreach` or `while`
header holding a semicolon is missed, because that header's bound stops at `;`:
`foreach (explode(';', $csv) as $row) {` is what import and CSV code looks like, which makes it not
a rare shape in exactly the code most likely to dispatch once per row. And a `for` header broken
over several lines is missed, because `for`'s bound stops at the newline as well — a `for` header
carries its own semicolons, so a `;` cannot bound it and only the line can. Neither bound is
arbitrary: they are what stops a header pattern from crossing out of its own construct and latching
onto some later `) {`, which is precisely how the alternative syntax used to swallow a whole file. A
`foreach` or `while` header spread over several lines does work; only `for` pays that part.

A missed loop costs a reader one glance at a diff they were already reading. An extent that runs to
the end of the file costs the credibility of every row printed under it, and a reader who has been
shown one invented coordinate is right to stop trusting the rest. That asymmetry is why the price is
paid on this side, and why it is written here as a price rather than left out as an omission.

Three limits beyond those. **`array_map` and friends are not matched**: the callback rules require a
`->` or `::` receiver, so a free function taking a closure is not a loop as far as this pack is
concerned. **A `for` whose unbraced body and the block after it share one line** is the one shape
that still over-reports, and it is left standing rather than papered over: a `;` cannot bound a
`for` header, so on `for ($i = 0; $i < 3; $i++) echo x(); if ($y) { Sync::dispatch(); }` the pattern
runs past the loop's own body and latches onto the `if`'s brace, and the dispatch inside the `if` is
reported with the `for` as its loop. Only the line bound contains it, so the whole shape has to be
written on one line, which is why it survives: bounding it further would need the paren balancing a
regex does not have, and every formatter in ordinary use breaks that line. And **the number of
iterations is never knowable from source**: how many rows a query returns is not written anywhere a
regex can reach.

The string-literal blind spot below applies here as it does to transactions — the source these rules
see is comment-masked and not string-masked, so a loop keyword inside a quoted string or a heredoc
still matches. The brace requirement narrows that to strings which literally contain `) {`, a
smaller set than "any string mentioning `foreach`" and not an empty one. The `fn` rule is the
exposed one, because it balances parentheses rather than braces, and a stray parenthesis in a string
is far commoner than a stray brace: `'(inclusive)'` in a message ends its extent early, and an
unmatched `(` extends it.

That last limit is why `empo review` prints these sites as a fact and never as a finding. It lists
every dispatch a changed file makes from inside a loop, with the line the loop opened at, and then
says in the same breath that this says nothing about volume (`commands/review.ts`, `printFanout`). A
coordinate with no sentence under it reads as an accusation, and this axis has nothing to accuse
anybody of. What it is good for is the moment a diff widens what a loop iterates: the query changed
upstream, the dispatch downstream did not, and nothing in the diff shows the two lines together. The
reviewing model can go and read the query; EmPo can only make sure the question gets asked out loud
while somebody is still reading.

**Two blind spots, both structural, neither a bug to be fixed later.** They belong to the walk
rather than to the transaction axis, so `loops` inherits both of them exactly as written.

The first is a consequence of the masking rule in section 3. Comments are blanked before any pack
rule runs, so a commented-out transaction is invisible, but **string literals are deliberately not
masked**, because the `string` edge family and every route path live inside them. So a
`DB::transaction(` written inside a quoted string, in a test fixture, a documentation heredoc or a
generated code sample, matches and opens an extent that is not a transaction, and the dispatches it
appears to enclose are reported. It runs in both directions, and the directions are worth keeping
apart: a stray opening delimiter inside a string extends an extent and can invent a hazard, while a
stray closing one ends it early and hides a real one. Both are matters of where a regex hits, which
nothing short of a lexer would rule out. This is the price already paid for level-2 bridges, charged
again on a second axis, and the honest reading of a hazard row is that its transaction line is where
a pack pattern matched, not where a transaction provably began.

One face of it is closed rather than accepted, and the asymmetry says which failures this axis will
tolerate. The statement boundary above steps over string literals, because a `;` inside a dispatch's
arguments would otherwise cut the statement short, drop the chained defer marker after it and report
a hazard against code that already waits for the commit. Under-reporting is a gap and over-reporting
is a fabricated finding, and the two are not equally acceptable here.

The second is the harder one. Detection is regex plus delimiter-walking, not parsing, so **enclosure
is lexical**. A dispatch is a hazard here only when it is written between the two coordinates of a
transaction in one file. A dispatch reached through a helper the transaction calls is invisible,
however certain it is at runtime: a `DB::transaction(function () { … })` whose body calls
`$this->finalise($order)`, with the dispatch inside `finalise()`, is exactly the shape this feature
exists to catch and exactly the shape it cannot see. The same goes for a transaction opened in a
parent class or a middleware and committed somewhere else entirely. So the list is the same thing
every other answer here is: a floor, not a ceiling ([00-overview](00-overview.md)). A repository with
an empty hazard list has not been proved clean, it has been proved to hold no dispatch written inside
a transaction block in one file.

### 8. `aliasSources`: where the toolchain keeps its alias map

Optional, read by `empo init` and by nothing else. It names the file a root's toolchain writes its
import aliases in, and the fields inside it, so init can seed the root's `aliases` in config
([03-config-schema](03-config-schema.md)) instead of leaving a human to copy a tsconfig by hand.

| Field | Required | Meaning |
|-------|----------|---------|
| `file` | yes | Relative to the root's directory, as the repository writes it: `tsconfig.json`. |
| `paths` | yes | Dotted field path to the map of pattern to target: `compilerOptions.paths`. |
| `base` | no | Dotted field path to the directory targets are relative to: `compilerOptions.baseUrl`. |
| `extends` | no | Dotted field path to a file this one inherits from: `extends`. |

**Every field but `file` is a dotted field path into the parsed document rather than a value, and
that is the whole point of the block.** The seeder has to open `tsconfig.json` and read
`compilerOptions.paths`, and both of those strings are TypeScript facts. Written into `src/engine/`
they would be **the first language-specific logic in the engine**, which is the one thing this
contract exists to prevent. Written here they are what every other language fact in EmPo is, a line
in a pack: a toolchain that keeps its map at the top level declares `paths`, and a python or go pack
fills the same three fields with its own answers and needs no line of `engine/aliases.ts` changed.
It is the same split `comments` already makes, where a pack names `//` and the engine walks it.

**A pack that declares none is a language whose imports carry no aliases**, and that is a statement
rather than an omission: init prints the section only where some pack in play declares a source, so a
repository of such a language is told nothing instead of being told it found nothing. It is the line
`hazards` draws one section up, with the difference that this one costs nothing to leave undeclared,
because the field it seeds is a human's either way.

**Read by `empo init` only, never by `empo index`.** A build never opens one of these files. What a
root resolves is whatever a human left in `aliases` after reading what init seeded, which is what
keeps the graph a function of the config plus the scanned files and reproducible on a machine with
no toolchain installed. The seeder is correspondingly forgiving where a resolver could not be: it
reads JSON with comments and trailing commas through `engine/mask.ts`, follows a relative `extends`
chain nearest-wins to a depth of 8, refuses to follow an `extends` that names a package, and turns
every gap into a note `empo init` prints ([06-cli](06-cli.md)) rather than into a narrower map nobody
was told about.

**The typescript pack declares two sources, `tsconfig.json` and `jsconfig.json`, and moved 1.2.0 to
1.3.0 for them.** The bump was demanded rather than remembered: `test/packs/versions.test.ts` hashes
the parsed pack and fails when behaviour moves without the version, which is the pin that closed the
gap where a pack could change behaviour and leave its version where it was. It is worth
knowing what that bump does and does not mean here. `aliasSources` is read at init time and never
serialized into a graph, so a graph built before the edit answers identically to one built after,
which is the argument the php pack's `arrivedBy` edit used for staying at 1.5.0. The pin
over-demands on purpose: the maintained list of which fields stale a graph is exactly the "whoever
remembers" the pin exists to end, so one bump nobody needed is the direction to fail in.

### 9. There is no escape hatch

**A pack is rules and nothing else.** An early sketch gave a pack an optional `module`: a path to a
small JS file exporting `refine(node, edges, source)`, run after the rules and free to correct what
regex could not express. The declaration shipped and the loader never did, so for as long as the
field existed the schema accepted a path to a file no engine code ever opened, and a pack asking for
an escape hatch had it dropped without a word — the silent-failure shape this document argues
against in every other section. Neither shipped pack ever named one, so the field was removed rather
than repaired: a contract that advertises a hatch is worse than one that never offered it.

Removing the declaration does not make a pack that still names `module` fail. Unknown keys are
stripped at load like any other the schema does not name, which is the schema's general rule and is
written down where that rule lives (`assertionExcludes` in `schema/pack.schema.ts`, and the header
of `test/packs/versions.test.ts`). What changed is that the contract no longer promises something
the engine cannot deliver, which is the half of the silence a deletion can actually fix.

The design constraint that closed it stands, and is the reason not to reopen it. Every line in such
a module would be language-specific code the declarative rules exist to avoid, and a pack growing
one is the signal that the rule vocabulary is short a word. When a pack needs something the rules
cannot express, the engine grows a new `resolve` strategy — engine-side, spelled the same way for
every language, and rejected at load when a pack names one that does not exist.

## How patterns are compiled and anchored

Every pattern a pack declares that runs over a file's **source** is compiled with the `m` flag, so
`^` and `$` mean line start and line end, never file start and file end. Edge rules and source
symbol rules add `g` and yield every match in the file; the node id and kind patterns run without
it, because only the first match identifies a file.

A `pathPattern` is the one exception, and it has to be. It is compiled with no flags at all
(`engine/extractor.ts`), because it runs once against a single path string rather than down a file,
so it carries no `g`: a file has one identity, not one per line. The missing `m` costs it nothing in
practice, since a path holds no newline for `^` and `$` to find, but it does mean its anchors are
string start and string end, and a path rule should be read that way. The typescript pack's shipped
`"(?:^|/)Pages/(.+)\\.(?:vue|tsx|jsx)$"` is written for exactly that reading: `$` pins the extension
to the end of the whole repo-relative path, and the leading `(?:^|/)` rather than a bare `^` is what
lets a `Pages` segment sit anywhere in it, which is the alternation a line-anchored reading would
think unnecessary.

Anchor a line-leading rule with `^[ \t]*` and not with `^\s*`. `\s` matches newlines, so `^\s*use`
starts its match on the blank line before the `use` statement, and since the evidence line comes from
the match index the edge is then reported one line too early. That was a real bug, caught by the php
fixture snapshot rather than by reading the pattern, which is the argument for writing the snapshot
first. A rule that over-matches by one line is not cosmetic: it puts a wrong `file:line` in front of
whoever follows the citation, and citations are the whole contract.

## Packs that ship in v1

Two, deliberately different, to keep the interface honest:

- **php** (`strategy: fqcn`, all six edge families, `inherit` included since it gained the two
  `class … extends` rules, Laravel extractors for routes, observers,
  Blade component tags and the four rules that render a view by name — the directives whose first
  argument is a template (`@extends`, `@include`, `@includeIf`, `@component`, `@each`), a global
  `view('x')`, `View::make` and `Route::view`'s second argument — `produces`
  http-routes, `consumes` both http-routes and the Inertia page
  names the typescript pack produces). It is the one pack that declares a `views` block, which those
  four rules are the only reader of, the one pack that declares a `scopes` block — three rules sharing
  the name `route-prefix`, two `balanced` ones reading a `Route::prefix('api')->group(function () {…})`
  and a `Route::group(['prefix' => 'api'], …)`, and the `file` one reading the `RouteServiceProvider`
  line that loads `routes/api.php` under a prefix, so its `produces` rule keys `GET api/orders`
  where it used to key `GET orders` — the one pack whose `produces` declares `keys`, expanding a
  `Route::resource` into the eight keys its seven actions need and a `Route::apiResource` into the
  six its five need — `update` is one action answering both `PUT` and `PATCH`, and that is two
  keys — the one pack that declares a `hazards` block, covering
  all three Laravel
  transaction forms — the closure, the arrow function and the manual begin/commit pair — seven
  spellings that hand work to a queue — the three `dispatch` forms, the
  `Mail` facade's `queue()`/`later()`, the `Queue` facade's `push()`/`pushOn()`/`later()`/
  `laterOn()`/`bulk()`, `->notify(new …)` and `Notification::send()`, which is a floor and not the
  whole of Laravel — `->afterCommit()` at the site and
  `public $afterCommit = true` on the job, and the one that declares a compound-extension comment
  syntax, `.blade.php` masking `{{-- --}}`.
- **typescript** (`strategy: symbol`, with the `symbolPattern` that reads an exported `function`,
  `class`, `abstract class`, `const`, `let`, `var`, `type`, `interface` or `enum` written at column 0,
  together with any run of decorator lines written directly above it,
  four `import` rules, two `template` rules for the JSX and
  Vue component tag, scoped with `pathGlob` to `**/*.{tsx,jsx,vue}` and confined by `targetKinds` to
  landing on a `component` or a `screen`, three `declares` patterns so those two rules refuse a tag
  naming something the rendering file declares itself, a `packages` block naming `package.json`,
  `name` and npm's four dependency maps so they refuse a tag naming something the file imports from a
  package, neither a `hook` nor an `inherit` family at all — `extends` in TypeScript is carried by an
  `import` the language makes it write, which is the whole reason php needs a family for it —
  http-route
  `consumes` rules for
  fetch and axios, and one `produces` rule that reads an Inertia page name off the file's path rather
  than out of its source).
  It is the mirror image of the php pack on every
  axis that matters, which is what makes it a test of the contract rather than a second example of
  it. It is also the only pack that declares `aliasSources`, naming `tsconfig.json` and
  `jsconfig.json`, because it is the only one whose language writes an alias map at all.

Python and Go are post-v1 and should each be a pack-only pull request. If either requires an
engine change, that change is a signal the contract is still leaking and should be generalized,
not special-cased.

### What the route rules are worth, measured

The `scopes` block and the `keys` expansion were both written against a real Laravel application,
and the point of measuring them there is that a route rule is the one part of a pack whose answer
can be checked against the framework itself: `php artisan route:list --json` is the list of URLs the
application really serves, so the pack's `produces` keys can be diffed against the truth instead of
against a fixture somebody wrote to agree with them.

Two applications, deliberately unalike. The first is a 5084-file Laravel 10 monolith registering 3748
routes statically from fourteen route files, ten of them mounted under a prefix by a
`RouteServiceProvider`. The second is a Laravel 11 Inertia application whose routing is configured in
`bootstrap/app.php` and whose route files mount each other, one level deep.

| | keys produced | of which real | precision | recall |
|---|---|---|---|---|
| monolith, before | 1429 | 711 | 49.8% | 19.0% |
| monolith, after | 3602 | 3602 | 100% | 96.1% |
| Inertia app, before | 94 | 4 | 4.3% | 2.4% |
| Inertia app, after | 159 | 159 | 100% | 94.6% |

Three defects were found by this measurement and by nothing in the test suite, which is the argument
for measuring a route rule against the framework at all. The array-form scope's lazy quantifier let a
group setting no prefix reach past its own closing bracket and adopt the prefix of a group sixty
lines below it, so routes at the top of a file came out under `admin/settings/`; the pattern is now
tempered against crossing `Route::` or `function`. The `file` extent resolved one link and not the
chain, so the Laravel 11 application's `routes/v2_admin.php`, mounted under `admin` by a file itself
mounted under `v2`, keyed `admin/…`. And a `balanced` extent counted its delimiters in the raw
source, where a single stray brace in a string — `Route::post('bookings/{booking}/print}', …)`, a
typo in a URL — closed a group sixty routes early and every route below it came out short by a
segment. Delimiters are now counted on the string-blanked view while the value is still read from the
one that has its strings.

What remains is the contract rather than an unwritten rule. The monolith binds its own
`ResourceRegistrar` into the container, so every resource it registers carries an extra route that
exists only once the container is built: 1578 URLs no static reader can see, in any tool, and the
plainest example this repository has of why every answer here is a floor. The code that registers
them says nothing, and the line that makes them exist is a `bind()` in a service provider.

The remaining gaps in the rules themselves are declines rather than guesses, which is why precision
is 100% on both applications and recall is not. A resource written with a dot,
`Route::resource('orders.lines', …)`, is a nested resource whose URL Laravel builds by singularizing
the parent, which no regex holds, so the pattern excludes a dotted name and produces nothing rather
than eight wrong keys. A resource narrowed by `->only([…])`, or by an `->except([…])` naming anything
other than `show`, is refused by a lookahead for the same reason: the seven actions are no longer
what it registers, and which ones survive is in the argument list. The one narrowing that is read is
`->except(['show'])`, which drops exactly one action off a shape a regex can still spell whole, and
it has a rule of its own declaring the seven keys that remain.

A route file mounted more than once claims no prefix at all, and that is the third decline. Two
providers naming one route file are two mounts of it: the routes really do answer under `api/orders`
and under `admin/orders`, and the pass has one value per scope name to hand back. Concatenating the
two keys `api/admin/orders`, a well-formed route nobody serves, and picking one silently drops every
URL the other one registers, with nothing at the far end to say which half went missing. It is the
same reading as the mounting cycle above it — a file whose prefix cannot be *said* is given none —
and it costs recall on a repository that mounts a shared route file twice on purpose.

Laravel 11's default mount is not read either, and it is worth naming because it is the current
major's stock spelling rather than an exotic one. The only `file`-extent scope requires
`Route::prefix('api')->group(base_path('routes/api.php'))`: a `prefix` call, a `group` call, and a
quoted path inside a `base_path`. Laravel 11's generated `bootstrap/app.php` writes
`->withRouting(web: __DIR__.'/../routes/web.php', api: __DIR__.'/../routes/api.php')` and applies the
`api` prefix itself, from the argument name and not from anything written as a prefix. That matches
neither the call shape nor the `base_path` argument, so every route in a stock Laravel 11
`routes/api.php` keys short by `api`. The Inertia application measured above configures its routing
in `bootstrap/app.php` too, and its mounts are written in the form the rule does read, which is why
the measurement above shows none of this and is not evidence against it. It
falls under the general caveat that a key which comes out unprefixed has not been proved unprefixed,
but a default shipped by the framework deserves its name written down rather than left to a caveat.

One rule can over-report, and the precision figures above are a measurement of two applications
rather than a proof that it cannot. The general `Route::resource` rule refuses a narrowed resource
with a negative lookahead bounded by `[^;]*`, and a `produces` pattern reads the view that still has
its string contents, so the bound is textual: a semicolon written inside a string anywhere in the
chain stops the lookahead's scan before it reaches the narrowing.
`Route::resource('orders', OrderController::class)->middleware('role:admin;editor')->only(['index']);`
therefore matches, and emits all eight keys for a resource that registers one route. Neither measured
application writes one, which is why precision came out at 100% and not why it must.

### What the typescript pack forced, and what it did not

The point of building the second pack was to find out where the interface had quietly assumed PHP.
Three things had, and each was fixed by generalizing the engine rather than by special-casing TS:

- **A path-shaped node id was root-relative.** It is now repo-relative, for both `module-path` and
  `fallback: "path"`. See [05-graph-model](05-graph-model.md); the short version is that two roots of
  one language collide, and an import across a root cannot resolve.
- **Directory resolution was about to be hardcoded.** It became `node.id.indexNames`, declared by
  the pack, so Python's `__init__` needs no engine change.
- **`tests.paths` was prefix-only.** It now also accepts globs, because a colocated test is a
  convention, not an oddity.

Nothing else moved. The extraction pipeline, the resolver's contract, the symbol tables, the fixture
gate and the determinism rules all took a `module-path` pack unchanged, which is the result this
exercise was run to get. **That sentence held until the pack declared edge rules of its own**, and
the two fields it then forced, `pathGlob` on an extract rule and `targetKinds` beside it (section 4),
are the same shape as the three above rather than an exception to them: one says where a rule may
look and the other says what a name may resolve to, both are read by the engine with no language
string in it, and the php pack can declare either tomorrow.

A fourth generalization landed afterwards and belongs beside those three, because it says something
they do not: what forced it was not the second pack but the first bridge between the two. The
typescript pack did ship with `consumes` and no `produces`, and the Inertia bridge gave it one. A
symbol whose identity is where the file sits needed `pathPattern` beside `pattern` (section 5), and
with it the pack produces `inertia-page` from every `Pages/*.vue`, `Pages/*.tsx` and `Pages/*.jsx`
path while the php pack consumes it from every `Inertia::render` call. So the pack is no longer the
produces-less half of the contrast, and any reading of it as one is out of date. The pattern holds
all the same: the primitive is general (any convention that references a file by its path fits it)
rather than an Inertia special case, which is the engine growing a vocabulary rather than a language
leaking into it.

The side-effect import (`import "./register-handlers";`) was recorded here as a deliberate absence,
on the grounds that a rule with no line in the fixture corpus proving it is a rule nobody has tested,
and that it lands the day the corpus grows one. The corpus grew two, so it landed: a fourth import
rule, `^[ \t]*import\s*['"]([^'"]+)['"]`, which is the shape the other three cannot reach because it
carries no binding clause and no call parens. What it bought is the module every importer reached
silently: a registration file, a polyfill, a css module, a test setup file, each of which read as
fan-in of zero while the pack wanted a `from`. The `\s*` is not `\s+` so that `import"./x"`, which
is what a minifier writes, reads the same as the spaced spelling the clause rule beside it already
takes through `[\s{]`; `import` followed straight by a quote is a side-effect import and can be
nothing else. The one thing the typescript pack still deliberately does not do is refuse a type-only
import: it reads `import type { Money } from "./money"` as a real edge, unlike the docblock
references [05-graph-model](05-graph-model.md) excludes: a PHP `@property` annotation is
documentation, while a TypeScript type import is checked by the compiler, so changing the type
really does break the file that imported it.

A further absence is worth naming with less certainty than that one, because nobody has argued it
either way yet: the typescript pack declares no `hazards` block. Section 7's rule then applies to it,
so this repository's own `empo query --hazards`, which indexes itself with that pack alone, answers
that no pack in play looks rather than that it is clean. A Node queue and a transaction can hold the
same hazard, so the question is open rather than settled, and settling it means a fixture corpus with
the shapes in it before any rule is written.

## Testing a pack

Every pack ships with a fixture corpus: a tiny synthetic source tree and an expected snapshot of the
four axes a pack produces, nodes, edges, hazards and names. `empo pack test <name>` runs the pack
against its fixtures and diffs the result. Hazards are held to the same snapshot as the first two,
because hazard rules are regexes like every other rule in a pack and a pattern that stops matching
should
come back red from the pack's own corpus rather than from a repository that changed. A pack declaring
no hazard rules snapshots an empty list, which is the same statement its absent block makes. This is
how a pull request that adds a language proves it works without any private
codebase, and it is the gate for accepting a new pack.

**`expected.json` gained a `names` block**, and it is the axis a snapshot is the only possible gate
for. A pack's name-resolving rules refuse silently by design (section 4), so a corpus whose yield
went to zero produces no diff at all: no edge disappears from the snapshot that was never in it, and
every other axis reads exactly as it did the day before. Pinning the counts is what makes the refusal
itself gate-able, so a rule that stops resolving, or a fixture edit that quietly makes a name
ambiguous, comes back red from the pack's own corpus rather than from somebody's repository. A pack
with no name-resolving rule snapshots an empty array, which is the same statement the hazard axis
makes with its own. The diff is keyed on the edge family and reports `changed names <family>` with
the expected and the actual record both printed under it, because the whole record is what says which
of the six counts moved.

**The typescript corpus grew a `<Spinner />` in `react/cards/OrderCard.tsx`** to close the one hole
in it. `unknown`, a name carried by no node at all, was the one verdict the corpus never
reached, so the separation between "in no node" and "ambiguous" — the separation the two counts exist
to keep — was ungated. `Spinner` is imported from `@acme/ui` and is defined nowhere in the tree, so
the tag is refused before ambiguity or `targetKinds` is consulted, which is the ordinary cost of
reading a language whose vendor components are spelled exactly like local ones.

**Three more files landed with the case fold and `declares`, for the same reason.** A fold and a
refusal are both invisible in the edge list of a corpus that never asks for one, so the corpus now
asks. `react/cards/cardFooter.tsx` is a component file named in lowerCamelCase while the tag that
renders it is `<CardFooter />`, and `react/cards/CardShelf.tsx` renders exactly that tag: the exact
index carries `cardFooter` and nothing carries `CardFooter`, so before the fold that reference was
`unknown` and the component was rendered, in this graph, by nobody. `CardShelf.tsx` imports it as
`./cardFooter`, which is what corroborates the fold: strip that import and the reference goes back to
`unknown`, so the snapshot pins the witness as well as the fold. `CardHeader.tsx` beside it is
spelled as its own tag and is answered by the exact map with no witness asked for, which is what pins
the fold as a fallback rather than as the primary lookup. `react/cards/CardStory.tsx` is the other
half: it declares a component of its own — `const CardFooter` then, `const OrderCard` since the
ordering moved, for the reason given below — and renders both that tag and `<CardHeader />`, so the
snapshot pins that the shadowed name is refused as `local` while the tag the file does not declare
still resolves — the refusal is about the name, not about the file that wrote it. The corpus went
from 40 nodes to 43 and its `template` record from 14 resolved to 16, with `local` at 1, and no
count that was there before moved: `unknown` is still 1, `ambiguous` still 2 over `Badge` and
`Total`, `wrongKind` still 1.

**`packages` cost the corpus a manifest, a workspace manifest and one more file**, because a verdict
that needs a dependency declared cannot be reached by a source tree alone. `package.json` at the
corpus root is named `@acme/corpus` and depends on `@acme/ui` and `react`, with `axios` in
`devDependencies` so more than one dependency field is under the snapshot;
`src/browser/widgets/package.json` is named `@acme/widgets` and is the workspace half, a manifest
sitting under the tree rather than at its top. `react/cards/VendorCard.tsx` renders one
tag of each shape. `<CardHeader />` is imported from `@acme/ui` and is refused as `vendor` even
though `cards/CardHeader.tsx` sits beside it, carries the name exactly and is kinded `component` —
which is the whole point, since every question the strategy asks about that name answers yes.
`<PriceWidget />` is imported from `@acme/widgets`, is equally bare and equally unresolvable as a
path, and **resolves**, because that name is one the repository declares about itself and no manifest
depends on. The corpus pins the consequence rather than the mechanism, since the subtraction only
bites where one manifest's `name` is another manifest's dependency; that case is taken directly in
`test/engine/packages.test.ts`, where a root depending on `@acme/ui` and
`@mui/material` beside a `packages/ui` named `@acme/ui` yields `@mui/material` and `sonner` and not
the workspace.

**`CardStory.tsx` now shadows `OrderCard` rather than `CardFooter`**, and the edit is the ordering
above showing up in the corpus. `local` is asked last, so it is only reachable where the index would
otherwise have resolved: `CardFooter` reaches it through the fold, which `CardStory.tsx` does not
corroborate, so that name is honestly `unknown` and the shadow verdict was no longer gated by
anything. `OrderCard.tsx` is carried by the exact index and kinded `component`, so a file declaring
its own `const OrderCard` and rendering it is the case `local` exists for. With all of it the corpus
stood at 47 nodes and its `template` record read `resolved 19, unknown 1, ambiguous 2, wrongKind 1,
local 1, vendor 1`, which is where it was when the pack still ided a node by its path.

**Adopting `symbol` at pack 2.0.0 cost the corpus one template edge, and the loss is worth stating
rather than absorbing.** `src/components/PriceRow.tsx` and `src/browser/widgets/priceRow.jsx` both
export a symbol spelled `PriceRow`. Under a path-shaped id the two nodes were named from their
basenames, `PriceRow` and `priceRow`, so the exact short-name map held one `PriceRow` and `<PriceRow
/>` resolved to it, with the second file reachable only through the case fold. Under `symbol` a
node's short name is the export name, both files export `PriceRow` under that exact spelling, and the
map now holds two nodes of that name, so the reference is refused as `ambiguous`. Measured on the
adoption commit itself, with the corpus otherwise untouched, the `template` record went from
`resolved 19, ambiguous 2` to `resolved 18, ambiguous 3`, and the third ambiguous name is `PriceRow`
beside `Badge` and `Total`. The corpus has grown since, so read that as the arithmetic of the change
and not as the corpus's current totals, which the snapshot in `fixtures/expected.json` carries.

**Two of those three ambiguities are still ambiguous and the third is not, which is the kind filter
showing up in the same corpus.** The snapshot now reads `resolved 20, unknown 1, ambiguous 2,
wrongKind 1, local 1, vendor 1`, and the two names under `ambiguousNames` are `Badge` and `PriceRow`.
`Total` left the list when the filter moved ahead of the uniqueness test: `src/react/types/Total.ts`
is kinded `module` and the `template` rule lists only `component` and `screen`, so that node stops
being a candidate before it can be counted, `src/react/cards/Total.tsx` is left alone, and `<Total />`
resolves. The corpus gained exactly one edge for it and lost none, which is the whole measurement:
`src/react/cards/OrderRowList.tsx#OrderRowList -> src/react/cards/Total.tsx#Total`, family
`template`, cited at `OrderRowList.tsx:17`. Nor did dropping the type module cost anything, since
`Total.tsx` imports it and that `import` edge was already there and still is.

`Badge` and `PriceRow` are untouched by that change for the reason the paragraph above
gives about `OrderTable`: both of each pair are kinded `component`, so the filter removes neither and
the count still refuses. The one recovered and the two kept are the whole shape of what the order
change does: it drops what the rule could never have named and never picks between two things it
could.

The refusal is true rather than conservative, which is the reason it is accepted and not repaired.
Two files really do export that name, the graph really cannot say which one the tag meant, and the
old answer separated them by a file-naming convention rather than by anything the language declares.
Nor is the coupling lost: the file that renders the tag imports it, and the import edge still joins
the pair, so the blast radius holds the same two nodes it held before through a different family.
What changed is that a reader comparing `names` counts across the 1.x to 2.0.0 bump is comparing two
different namespaces: under 1.x a short name was a file basename, under 2.x it is an export name,
and a repository whose files and exports are spelled alike will find names that used to be unique
carried by two nodes and refused. The honest reading of a `template` count that fell across that
bump is a remeasure under a stricter namespace and not a regression in the rules, and the pack's
major version is exactly what says the two sets of counts are not comparable. This is the measurement
that shows why the bump was needed rather than optional.
