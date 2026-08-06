# 04. Language packs

This is the most important technical document in EmPo. The language pack is the abstraction that
makes one graph builder work across PHP, TypeScript, and anything added later. Get this interface
right and a new language is a data file. Get it wrong and every language leaks its assumptions
into the engine.

## What a pack is

A pack is **declarative first**: a JSON (or YAML) document of extraction rules, plus an optional
JavaScript escape hatch for the few things regex cannot express. The engine loads the pack, runs
its rules over the pack's files, and emits normalized nodes and edges into the shared graph. The
engine contains no language-specific logic. All of it lives in packs.

Extraction is **regex rules over source** and not an AST parse: imports, inline FQCNs, class-name
strings, template references, observer registrations. That approach generalizes cleanly across
languages, which an AST parser does not, since every language would bring its own.
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
      "indexNames": ["index"]                // module-path only: a basename that stands for its dir
    },
    "kindRules": [
      // resolvedBy:  the framework reaches this kind by name, so it has no fan-in, ever
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
    "hook":    [ { "pattern": "([A-Za-z0-9_]+)::observe\\(([A-Za-z0-9_]+)::class", "resolve": "observer" } ]
  },

  // 5. cross-language symbol tables (level 2)
  "produces": [
    { "symbol": "http-route",
      "pattern": "Route::(get|post|put|patch|delete)\\(\\s*['\"]([^'\"]+)['\"]",
      "map": { "method": 1, "path": 2 },      // part name -> capture group
      "key": "{method} {path}",               // how the parts become one key
      "normalize": { "method": ["upper"], "path": ["strip-leading-slash"] } }
  ],
  "consumes": [
    { "symbol": "http-route",
      "pattern": "\\$this->(get|post|put|patch|delete)\\(\\s*['\"]([^'\"]+)['\"]",
      "map": { "method": 1, "path": 2 },
      "key": "{method} {path}",
      "normalize": { "method": ["upper"], "path": ["strip-leading-slash"] } }
  ],

  // 6. how tests look, so the engine can compute coverage
  "tests": {
    "paths": ["tests/"],
    "importsRule": "import",                 // declared and validated; nothing reads it (see 6)
    "assertionTerms": ["assertEquals", "assertSame", "->toBe(", "assertTrue(", "assertDatabaseHas("],
    "assertionExcludes": ["assertTrue(method_exists("]  // the liveness spelling of a term above
  },

  // 7. optional: transaction hazards. A pack that omits this block makes no claim at all
  "hazards": {
    "transactions": [
      // the closure form only: an arrow-function transaction opens no block to balance
      { "pattern": "DB::transaction\\(\\s*function\\b",
        "extent": "balanced", "open": "{", "close": "}" },
      { "pattern": "DB::beginTransaction\\(", "extent": "span", "endPattern": "DB::commit\\(" }
    ],
    "dispatches": [ { "pattern": "([A-Za-z0-9_\\\\]+)::dispatch\\(", "job": 1 } ],
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
  ],

  // 9. optional escape hatch for what rules cannot express
  "module": "./packs/php/hard-cases.js"      // refine(node, edges, source); nothing loads it (see 9)
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
- `module-path`: id is the repo-relative file path (TypeScript, Go, Python where a file is a
  module of many exports).
- `symbol`: id is `path#exportName`, for languages where you want per-export granularity.

The strategy list is engine-side and closed here too, and only two of the three are built. `fqcn`
and `module-path` are implemented; `symbol` is declared and throws a "not implemented yet"
configuration error from `engine/extractor.ts`, and it lands with the first pack that wants
per-export granularity. A pack naming it fails loudly instead of quietly handing back the file-level
node the other two strategies produce, which is the same bargain the unimplemented `view` resolve
strategy makes below.

`fallback: "path"` covers the files the strategy cannot name: a route file, a bootstrap script,
anything with no class declaration in it. Without it those files yield no node at all, and
everything they declare (routes above all) is invisible to the graph, so a `fqcn` pack for a
framework with route files wants it. Leave it unset when a file with no unit of code should simply
be skipped.

`indexNames` is what `module-path` resolution needs and only it reads: the basenames that stand for
their own directory, so `import "../components"` finds `components/index.ts`. It is declared rather
than assumed because "index" is a Node convention and Python's answer is `__init__`. An engine that
hardcoded either would be a language leaking into the engine, which is the one thing this contract
exists to prevent. A pack that declares none resolves no directory imports, which is correct for a
language that has no such notion.

`kindRules` tag a node with a semantic kind (model, job, route-file, component, screen) by path
glob or content pattern, first match wins. Kinds drive both flow mapping and the review's
project-specific red flags.

`resolvedBy: "framework"` marks a kind the framework reaches by name or by convention, and not
through any edge the pack's rules could see: a blade view rendered by `view('orders.index')`, a
migration the runner discovers, a policy found by its class name. Those nodes have a fan-in of zero
whether they are used or not, so **the absence of an edge is not evidence about them**, and `empo
query --orphans` excludes them rather than offering them as dead code. Left unmarked, a Laravel
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
`string` edge family already catches. Each of those has a visible edge, so a fan-in of zero on one
of them is a genuine dead-code candidate, and marking it would hide a true positive. The question to
ask is whether deleting the file would break the application even though nothing in the repository
names it.

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
worth building. `--orphans` asks "is this dead?", where framework-resolved means there is no evidence
either way and so hide it; the brief asks "does a journey start here?", where a route file is
emphatically yes. Reusing the first answer for the second question throws away every route file,
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

Five edge families, each a list of `{ pattern, resolve }` rules. `resolve` names the strategy that
turns a captured string into a target node id:

| `resolve` | Turns a capture into |
|-----------|----------------------|
| `fqcn` | a class-id node, directly |
| `fqcn-string` | same, but the capture was a quoted string (morph maps, `call_user_func`) |
| `module-path` | a module-id node by resolving a relative import against the importing file |
| `view` | a template node by resolving a view name against the framework's view roots |
| `observer` | a hook edge from the observed model to the listener class |
| `short-name` | a class-id node by looking one short name up in the index of names |

A TypeScript pack uses `import` with `resolve: module-path` and has no `hook` family. The php pack
that ships uses all five, `template` included since it gained the Blade component tag, and the
typescript pack now populates `template` too, from a JSX tag and from the same tag in a Vue SFC. The
engine does not care which families a pack populates.

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
only thing the graph says about that pair. **The uniqueness question is asked first and the filter is
applied to the survivor**, which is the order that only ever refuses: a name in several nodes yields
nothing whatever the kinds are, and a name in exactly one node yields nothing if that node is of a
kind the rule does not list. This document said the opposite order at first, on the
argument that two files named `Badge` of which one is a component and one a type module would leave
exactly one candidate and resolve. **Running it is what settled it**: in a repository holding both
`components/Link.tsx` and `util/Link.ts`, a `<Link />` that names react-router's component resolved
to the local component under the filter-first order and to nothing under the shipped one, and the tag
names neither file. Narrowing the candidate list does not make an unreadable name readable; it hides
the ambiguity behind a plausible pick, which is a confident wrong answer where the refusal was merely
a missing edge. So the field closes the case where the basename twin is the **only** candidate and
leaves the ambiguous case exactly as `short-name` already had it. Which kinds a tag can name is a
fact about the language, so it stays pack data like every other language fact, and the kind and the
rule are declared in the same file.

The strategy list is engine-side and closed: a pack selects one, it cannot define one. Implemented
today are `fqcn`, `fqcn-string`, `observer`, `module-path` and `short-name`. `view` is declared and
throws a "not implemented yet" error from `engine/resolver.ts`. A pack naming it fails loudly instead
of quietly producing no edges. Note that `view` and `short-name` are different strategies for
different jobs and neither replaces the other: `short-name` is template-to-**class**, and `view` is
template-to-**template**, resolving `@include('orders.row')` against the framework's view roots.

`short-name` is the plain form of `observer`: capture one name, look it up in the index of node
names, emit an edge from the file that wrote it. It shares `observer`'s refusal rather than
reimplementing it, which is deliberate, because two strategies that answered "is this name
unambiguous" differently would be a defect invisible from either pack. So a name in no node yields
nothing (a vendor component, or a Blade built-in like `<x-slot>`), and so does a name in several. The
ambiguity bites harder here than it does for observers: `forms.text-input` and `fields.text-input`
both fold to `TextInput`, and a component library with namespaced folders is the normal case rather
than the odd one. **Resolved against refused is counted rather than assumed**, on whatever repository
the pack is pointed at. Every name these two strategies read reaches one of four verdicts:
`resolved`, `unknown` (the name is in no node at all — a vendor component, a Blade built-in like
`<x-slot>`), `ambiguous` (the name is in several nodes, so no edge is emitted to any of them) and
`wrong-kind` (the name is in exactly one node, of a kind the rule's `targetKinds` does not list). The
tally is recorded on the graph as `names`, one record per edge family, counted per **reference read**
and not per distinct name, and both `empo index` and `empo doctor` print it
([06-cli](06-cli.md)).
Where the rule declares `targetKinds`, the uniqueness question is asked first and the
filter is applied to whatever survived it, so a name carried by two nodes is ambiguous even where
only one of the two is a legal target: `resolveName` in `engine/resolver.ts` refuses on the count
before it looks at a kind, and its docstring records why. That order is also why the two refusals are
counted apart: `ambiguous` is the only one of the three that hides a coupling this repository really
has.

**It bites harder again in React, and now with a number.** The refusal is per name and not per
reference, so one duplicate basename anywhere in the repository removes every edge to that name,
including the ones written in a file whose own import says which is meant. **Measured**
on a synthetic 16-file React tree: adding a second `OrderTable.tsx` under another feature directory
took it from 12 template edges to 7, in silence, and on a 640-file copy where every component name
was 40-way ambiguous no template edge resolved at all. It fails safe, which is the right direction.
`targetKinds` does not soften that measurement at all, because the collapse is decided before any
kind is consulted: the count is what refuses, and it refuses whether the duplicate is a component, a
type module or a test.

**What the count changed is the silence, and not one of those two measurements.** Stated plainly,
because the distinction is easy to lose: counting the refusal is not narrowing it. The second
`OrderTable.tsx` still takes the 16-file tree from 12 template edges to 7, the 640-file copy still
resolves no template edge at all, and every name refused before is refused now. What is different is
that both runs say so, so "this family found nothing" and "this family had nothing to find" stop
reading alike — that was the whole of the defect, and a strategy whose yield can be zero without
saying so was not one anybody could call proven. Narrowing the refusal is a separate and larger
change, and nothing here should be read as having made it.

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

This is the single highest-leverage part of the pack. It is what lets `empo query` on a controller
report the mobile screen that calls it, or on a Vue page report the controller that renders it.

### 6. `tests`: coverage

The engine needs to answer "does any test assert on what this code produces." A pack declares
where tests live and which tokens count as a real assertion. `assertionTerms` is what separates a
test that asserts a value from a test that only asserts HTTP 200. The spine layer
([08-spines](08-spines.md)) refines this per spine (a money spine wants assertions on amounts in
cents), but the pack sets the language-wide default.

`importsRule` names an edge family and is read by nothing. Both shipped packs set it to `import`,
the schema defaults it to `import` for a pack that omits it, and no engine code looks at the value.
Coverage walks out of a test node along every edge that is not a cross-root bridge
(`engine/coverage.ts`), so a test reaches code through `fqcn`, `string` and `hook` edges exactly as
it does through `import` ones. That is both the wider behaviour and the more useful one, because a
test naming a class in a string couples to it as hard as one importing it, so the field describes a
narrowing the engine deliberately does not do. It is written down here rather than quietly left in
the packs, because a reader who takes the field at its word would conclude that a test's reach stops
at one family and would misread every coverage answer that came through another.

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

### 7. `hazards`: the optional transaction axis

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

Four fields, and every string in all four is a marker the engine walks rather than a language the
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
  only the spelling that really opens a block: the php pack's requires the `function` keyword, because
  an arrow-function transaction opens none and the walker would balance the next unrelated block
  instead.
- **`dispatches`** is a list of `{ pattern, job }`, where `job` is the 1-based capture group holding
  the dispatched job's name. It is a group number and not a convention, because a language spells the
  dispatch two or three ways and the name does not sit in the same place in all of them. Two rules
  that both describe one call site produce one hazard and not two.
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

**Two blind spots, both structural, neither a bug to be fixed later.**

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

### 9. `module`: the escape hatch

**Declared, not built.** Regex handles the overwhelming majority. For the residue (a framework macro
that registers routes in a loop, a re-export barrel file that needs resolving) a pack was to ship a
small JS module exporting `refine(node, edges, source)`, running after the rules and free to add or
correct edges. The declaration half of that exists: `module` is an optional string on the pack
schema and `PackModule` is an interface in `schema/types.ts`. The loading half does not. No engine
code imports, requires or calls whatever path a pack puts there, so a pack naming a module is
validated, accepted, and has its escape hatch dropped without a word, which is precisely the
silent-failure shape this document argues against everywhere else. Neither shipped pack names one,
so nothing is broken today, and this is unscheduled work rather than a regression: a pack `module`
is where AST-level precision would go if a repository ever genuinely needed it, and nothing
schedules the loader. Whoever builds it should make an unloadable `module` fail
loudly, the way a pack naming an unimplemented `resolve` strategy already does.

The design constraint stands for whoever gets there. Keep it small; every line in such a module is
language-specific code the declarative rules were meant to avoid. If a pack's `module` grows large,
the rule vocabulary is missing something and the engine should grow a new `resolve` strategy
instead.

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

- **php** (`strategy: fqcn`, all five edge families, Laravel extractors for routes, observers and
  Blade component tags, `produces` http-routes, `consumes` both http-routes and the Inertia page
  names the typescript pack produces). It is the one pack that declares a `hazards` block, covering
  both Laravel
  transaction forms, the three spellings of a dispatch, `->afterCommit()` at the site and
  `public $afterCommit = true` on the job, and the one that declares a compound-extension comment
  syntax, `.blade.php` masking `{{-- --}}`.
- **typescript** (`strategy: module-path`, three `import` rules, two `template` rules for the JSX and
  Vue component tag, scoped with `pathGlob` to `**/*.{tsx,jsx,vue}` and confined by `targetKinds` to
  landing on a `component` or a `screen`, no `hook` family at all, http-route `consumes` rules for
  fetch and axios, and one `produces` rule that reads an Inertia page name off the file's path rather
  than out of its source).
  It is the mirror image of the php pack on every
  axis that matters, which is what makes it a test of the contract rather than a second example of
  it. It is also the only pack that declares `aliasSources`, naming `tsconfig.json` and
  `jsconfig.json`, because it is the only one whose language writes an alias map at all.

Python and Go are post-v1 and should each be a pack-only pull request. If either requires an
engine change, that change is a signal the contract is still leaking and should be generalized,
not special-cased.

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

Two things the typescript pack deliberately does not do, recorded so absence is not mistaken for
oversight. It has no rule for a side-effect import (`import "./register-handlers";`), because a rule
with no line in the fixture corpus proving it is a rule nobody has tested; it lands the day the
corpus grows one. And it reads `import type { Money } from "./money"` as a real edge, unlike the
docblock references [05-graph-model](05-graph-model.md) excludes: a PHP `@property` annotation is
documentation, while a TypeScript type import is checked by the compiler, so changing the type
really does break the file that imported it.

A third absence is worth naming with less certainty than those two, because nobody has argued it
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
of the four counts moved.

**The typescript corpus grew a `<Spinner />` in `react/cards/OrderCard.tsx`** to close the one hole
in it. `unknown`, a name carried by no node at all, was the one verdict of the four that corpus never
reached, so the separation between "in no node" and "ambiguous" — the separation the two counts exist
to keep — was ungated. `Spinner` is imported from `@acme/ui` and is defined nowhere in the tree, so
the tag is refused before ambiguity or `targetKinds` is consulted, which is the ordinary cost of
reading a language whose vendor components are spelled exactly like local ones.
