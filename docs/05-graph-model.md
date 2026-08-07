# 05. Graph model

`generated/graph.json` is the machine-owned substrate every deterministic command reads. This doc
specifies its schema. It is written only by `empo index`, never by hand, never by an agent.

## Top-level shape

```jsonc
{
  "schema": 5,                          // the format this file was written in, not the one empo writes
  "builtAgainst": "9cd9b6278…",         // git sha graph was built from
  "builtAtCommitSubject": "…",          // for human sanity when reading the file
  "roots": [ { "path": "apps/api", "lang": "php" }, … ],
  "packs": { "php": "1.0.0", "typescript": "1.0.0" },
  "stats": { "files": 3699, "nodes": 3241, "edges": 18734, "bridgedEdges": 212 },

  "nodes":  [ Node, … ],
  "edges":  [ Edge, … ],
  "flows":  { "orders": [ "<node-id>", … ], … },  // derived: which nodes belong to which flow
  "fanin":  { "<node-id>": 340, … },           // derived: distinct referencing nodes per node
  "coverage": { "orders": CoverageInfo, … },
  "hazards": [ Hazard, … ],                    // a second axis: dispatches inside a transaction
  "hazardsScanned": [ "php" ],                 // the langs whose pack looked, as of this build
  "names": [ NameResolution, … ]               // what the name-resolving rules did with what they read
}
```

`builtAgainst` plus a `git rev-list --count <builtAgainst>..HEAD` is how every command reports
staleness. The graph never hides its age.

`stats.nodes` can never exceed `stats.files`. A scanned file contributes at most one node, and the
count is taken from the deduplicated node list rather than from the per-root sum, so a file whose
pack rules produced nothing and an id two files both claimed each leave the node count below the
file count instead of above it. A graph.json whose nodes outnumber its files is not a large
repository, it is a file `empo index` did not write.

Every key in this file is camelCase. The TypeScript contracts in `src/schema/types.ts` and the pack
fixture snapshots already emit camelCase, so the file uses one representation and there is no rename
layer between the types and the disk format. A rename layer is where drift starts.

## Node

```jsonc
{
  "id": "Acme\\Libraries\\Price\\PriceCalculator",  // stable id per the pack's node.id.strategy
  "file": "apps/api/app/Libraries/Price/PriceCalculator.php",
  "root": "apps/api",
  "lang": "php",
  "kind": "class",                                  // from the pack's kindRules
  "name": "PriceCalculator",
  "produces": [ { "symbol": "http-route", "key": "POST v1/orders", "line": 143 } ],
  "consumes": [ { "symbol": "http-route", "key": "POST v1/orders", "line": 88 } ],
  "isTest": false,
  "assertsValue": false
}
```

`id` is the identity used everywhere else. For `fqcn` packs it is the class name; for
`module-path` packs, and for any file a `fqcn` pack names by its `fallback: "path"`, it is the
**repo-relative** file path, the same string as `file`. `produces`/`consumes` carry the symbol keys
after normalization, so the bridge matcher can join them without re-parsing.

Repo-relative and not root-relative, which is what this said until the typescript pack was built
against it. Root-relative ids collide the moment a monorepo holds two roots of one language, because
both have a `src/index.ts`, and dedupe would then drop a real file. They also cannot resolve an
import that crosses a root: `../../packages/ui/src/Button` only names a node when ids and roots are
measured from the same origin, and a monorepo-native graph exists to see exactly that edge. One rule
for every path-shaped id, so two roots can never claim one.

`assertsValue` is true only for a test node whose source contains one of the pack's
`tests.assertionTerms`. It is what the blind computation aggregates, so it lives on the node rather
than being recomputed per flow.

## Edge

```jsonc
{
  "from": "Acme\\Http\\Controllers\\OrderController",
  "to":   "Acme\\Libraries\\Price\\PriceCalculator",
  "kind": "import",              // import | fqcn | string | template | hook | bridge
  "symbol": null,               // set only for bridge edges: the symbol kind that joined them
  "evidence": { "file": "apps/api/…/OrderController.php", "line": 42 }
}
```

Edge kinds and where they come from:

| `kind` | Source | Level |
|--------|--------|-------|
| `import` | pack `edges.import` rules | 1 intra-language |
| `fqcn` | pack `edges.fqcn` rules (inline FQCN, no import) | 1 |
| `string` | pack `edges.string` rules (class name in a quoted string) | 1 |
| `template` | pack `edges.template` rules (a name inside a Blade/Twig/JSX tag or include) | 1 |
| `hook` | pack `edges.hook` rules (observer/listener registered in a provider) | 1 |
| `bridge` | symbol-table match across roots per a config `bridge` | 2 inter-language |

Every edge carries `evidence` (file and line) so `empo query` can cite where a coupling was found,
and so a human can go read it. A finding with no `file:line` is not allowed anywhere in EmPo; this
is where the citations start.

A `template` edge runs from the file that wrote the tag to the node the tag names, and both shipped
packs fill it. The php pack fills it from Blade's `<x-component>`, `<livewire:component>` and
`@livewire('component')` forms; the typescript pack from a PascalCase JSX tag and from the same tag
in a Vue SFC template, closing or self-closing in either language
([04-language-packs](04-language-packs.md) section 4 has the rules and why an opening tag is not one
of them). The typescript rules are scoped twice over, and both halves are pack data: `pathGlob`
confines them to the `.tsx`, `.jsx` and `.vue` files that can hold a tag, so no `.ts` module produces
one, and `targetKinds` lets them land only on a node kinded `component` or `screen`, so a tag whose
name belongs to a package cannot fall onto the lone local file that happens to share the basename.
That filter is applied to the survivor of the uniqueness test and not before it, so where two local
files carry the name the tag resolves to nothing, which is what `short-name` already did. Section 4
carries what each was measured to cost, what it did not, and why the other order invents an edge.
It is worth knowing that this makes
template files **sources** at scale where they used to be isolated, so it moves `--gods` and a blast
radius and not only a fan-in. Nothing yet produces an
edge *into* a template file: `view('orders.index')`, `@include`, `@extends` and an anonymous component are all
still invisible, which is the unbuilt `view` resolve strategy and not this one. Coverage and
`--blind` do not move for the same reason, because a template-to-class edge carries reach only if
something reaches the template first.

**One thing about the typescript side is genuinely new, and it is the overlap.** A blade file writes
no imports, so its template edge was the only edge between that pair. In React and in Vue the tag's
target is usually also imported by the file that renders it, so the pair now carries two edges, an
`import` and a `template`, where Blade's carried one. The case that pays for the family there is the
one where the overlap does not happen: a globally registered Vue component, or a Nuxt auto-import, is
rendered by a tag and imported by nothing, and its template edge is reach no import parser has. What
the overlap does and no longer does to `fanin` is the paragraph below. Two measured ways the
typescript side of this family gets it wrong, an edge invented from a component name written inside a
quoted string in a file that can hold a tag anyway, and every edge to a duplicated component basename
dropped in silence, carry their numbers in [04-language-packs](04-language-packs.md) section 4, and
the second is why nobody should assume this family yields much on a repository it has not been run
against.

There is exactly one edge per `(from, to, kind)`, and the earliest evidence wins. A second reference
between the same pair through the same kind is the same coupling, so it is dropped rather than
added. This is what keeps `fanin` from being a count of mentions: a file that names another twenty
times through one rule family still counts once.

**`fanin` counts distinct referencing nodes, not incoming edges**, and that is where the overlap
above stops. A file that imports a component and then renders it puts two edges into that component
and contributes **one**. The kind stays in the dedupe key, so the edge list still separates an import
from a render and still cites a line for each: how a coupling was found is what `kind` and `evidence`
carry. This number answers "how many things break if I change this", which is a count of things.
`empo query`'s consumer list follows the same rule and prints one row per referencing node, cited at
the **earliest coordinate** that node names this one, ties broken by the graph's own order. Earliest
and not first: the graph is sorted by from, to, `kind`, and the kind order is alphabetical, so
keeping the first row sent a reader of a php answer to a `\App\Models\Order::query()` on line 10
rather than to the `use` statement on line 4 that a consumer list is usually read for. Both edges are
still in the graph; only the row's citation changed.

**It was a count of edges once, and the record of why is worth keeping.** Because the
kind is part of the dedupe key, a php file that both `use`s a class and names it in a quoted string
produces an `import` edge and a `string` edge between the same pair, and that used to contribute two
to the class's fan-in for what a reader would call one coupling. The inflation was accepted as
deliberate and bounded: bounded by the number of edge families a pack declares, and visible in the
edge list, where a mention count would be neither. What retired it was the frequency and not the
argument. A rendered React or Vue component is nearly always imported by the file that renders it,
so once the typescript pack declared `template` rules the overlap became the norm rather than the
occasion, and the arithmetic contradicted itself in print. `empo query` on
`fixtures/acme-platform`'s `apps/portal/src/components/OrderTotal.vue`, which the one page that
imports it also renders, answered `fan-in     2 direct, 1 transitive (the direct ones included)` and
listed that single consumer twice, at `Show.vue:2` and `Show.vue:13`. The transitive number is the
size of a set of nodes, so it can never be the smaller of the two: the sentence was false and not
merely inflated. The same query now answers `1 direct, 1 transitive` with one consumer row.

## `flows.json`

`flows.json` is layer 2: the end-user journeys, and the one input to the graph a human owns. `empo
index` reads it from the path the config's `flows` names (`.empo/flows.json` by default) and joins
it to the nodes:

```jsonc
{
  "version": 1,
  "flows": {
    "orders": {
      "label": "Place an order",                     // optional
      "paths": [                                     // required
        "apps/api/app/Http/Controllers/OrderController.php",
        "apps/api/app/Libraries/Price",
        "apps/mobile/src/features/orders"
      ]
    }
  }
}
```

`paths` are repo-relative path prefixes, not root-relative ones, so a flow can cross roots. That is
what makes one journey span the API and the app.

A prefix matches a node's `file` only at a path boundary. Without that rule `app/Models/Order` would
silently claim the sibling `app/Models/OrderLine.php`, and a flow that quietly owns a file nobody
assigned to it is worse than one that owns too little.

The boundary is a path segment, not a slash, because a language spells one unit of code either as a
directory or as a file with an extension, and under PSR-4 or a TypeScript module folder the two sit
side by side. `app/Models/Order` therefore claims `app/Models/Order.php` and everything under
`app/Models/Order/`, and still never claims `app/Models/OrderLine.php`. Making the human write both
spellings would let a flow miss the very class it is named after, which is the same quiet
mis-assignment aimed the other way. A trailing slash on a declared prefix changes nothing, including
which prefix counts as longest. A leading `./` changes nothing either: `./app/Models` and
`app/Models` are one prefix written two ways, not two prefixes, so they claim the same nodes and tie
with each other at the same length. The one path this leaves claiming nothing is the one that spells
only the repository root, `.` or `./`, and it claims nothing by the boundary rule rather than by the
tie rule: it flattens to `.`, and a node's `file` never equals `.`, never begins `./` once flattened
and never begins `..`, so no candidate survives to be measured at all. The tie rule would not have
handed it the tree in any case, because ties are broken on prefix length and a shorter prefix loses
to a longer one instead of sharing with it, so even a root prefix that did match could take only the
nodes no narrower prefix had claimed. What the flattening has to avoid is the empty string, which is
not the same thing as `.`: zero is the length the search for the longest match starts from, so a
zero-length prefix joins the winners through the tie branch rather than being beaten by it, and the
extension branch of the boundary rule reads an empty prefix as matching any top-level name that
begins with a dot and holds no slash. A flow whose declared path spelled nothing would quietly own
those files, which is the silent mis-assignment the boundary rule exists to prevent, so
`normalizeRepoPath` lands `.`, `./`, `.//` and `/` on `.` and never on the empty string.

Longest matching prefix wins, and a tie shares: two flows declaring the same prefix both own the
node, which is how one file belongs to more than one journey. A more specific prefix beats a less
specific one, so a flow can claim a single file out of a directory another flow owns.

Every declared flow appears in `graph.flows`, empty ones included. A flow that matches nothing is a
fact worth seeing, not an absence to hide.

**A test node is never assigned to a flow**, however well a declared prefix matches it. A flow is the
code of a journey, and coverage asks whether a test *reaches* that code; a test inside the flow
reaches it by being it, since the walk below seeds its set with the starting node. That corrupts both
halves of `blind`, which is `reaches && !assertsValue`: a swallowed test that asserts makes the flow
`assertsValue` and unblindable, and a swallowed test that asserts nothing sets `reaches` alone, which
is the flow being called blind on its own evidence. Either way the field reports the flow's tests
instead of what reaches its code. The rule is invisible where tests live in their own tree, which is
why `fixtures/acme-platform` never showed it: no root there colocates a test, since `apps/api` and
`apps/mobile` keep theirs under `tests/` and `apps/portal` has none. It bites exactly
where a pack is asked to cope with the colocated test that `tests.paths` globs exist for. In a
repository that colocates them, a single prefix over a component directory swallowed 46 of its own
`*.test.ts` files, 45 of them asserting, so that flow's coverage was decided by the tests it had
absorbed.

The file is hand-edited, so it is validated by `src/schema/flows.schema.ts` like any other untrusted
input. A missing `flows.json` is not an error: the repo indexes with no flows.

## Derived indexes

`empo index` precomputes what queries need so a query is a lookup, not a graph walk:

- **`fanin`**: how many distinct nodes reference each node. The blast-radius headline number. Two
  edge families between the same pair are one referrer here and two rows in the edge list, which is
  the split the section above argues for. Also drives `empo
  query --gods` (the widest-blast-radius nodes in the repo). Only non-zero counts are stored, so a
  node absent from the map has a fan-in of zero. That absence is where `empo query --orphans` comes
  from, though absence alone is not the answer it gives: a kind its pack marks `resolvedBy:
  "framework"` is reached by name and its fan-in is zero whether it is used or not, so `--orphans`
  filters those out and names what it filtered ([06-cli](06-cli.md)). Test nodes are filtered too,
  and unlike the framework-resolved kinds they go in silence: a test nothing imports has a fan-in of
  zero by construction, so listing it would be the same false positive, but nothing counts the tests
  dropped this way and `--all` does not bring them back. What `--orphans` names as filtered is
  therefore only the framework-resolved half.
- **`flows`**: for each flow (from `flows.json`), the set of node ids assigned to it by longest
  path-prefix match, across roots, minus every test node, which no prefix ever claims. A node can
  belong to more than one flow.
- **`coverage`**: for each flow, whether any test node reaches it (via edges) and whether that test
  uses an assertion term. This is the "would a test notice" answer, and it is where `--blind`
  comes from: the flows some test reaches where no reaching test asserts a value, which is
  `reaches && !assertsValue` and nothing wider. A flow no test reaches at all is uncovered rather
  than blind, and the two are kept apart because they are different accusations. Blind says the flow
  looks tested and is not, which is the state that ships a wrong number quietly; uncovered says
  nobody claimed to test it, which every reader can already see.

A test's reach travels along every edge except one: a `bridge` edge whose two ends are in different
roots. That bridge is a call across a process boundary, and a test on one side is not evidence about
the other, because a mobile test asserting on a rendered string does not check what the API
returned. Counting it did something worse than overstate: the route file names every controller, so
one such test reached all of them, and a backend flow with no value assertion anywhere stopped being
reported blind. A coupling EmPo cannot see is a documented floor; a test EmPo invents is a broken
promise. Inside one root a bridge is an ordinary call and does carry reach, which is what keeps a
framework feature test that only hits its own HTTP route counting as a test of the code behind it.

### CoverageInfo

```jsonc
{
  "flow": "checkout",
  "testNodes": [ "Acme\\Tests\\Feature\\CheckoutTest" ],
  "reaches": true,             // some test node has an edge path into this flow
  "assertsValue": false,       // but none of them uses an assertion term on a produced value
  "blind": true                // reaches but does not assert value -> flying blind
}
```

`blind: true` is the single most important field for the money/critical case: the flow is
exercised but nothing checks the number, so a wrong value ships silently. `empo query` surfaces
this in capitals because it is the most important sentence in the answer.

## Hazards

```jsonc
{
  "file": "apps/api/app/Http/Controllers/OrderController.php",  // the dispatch site, repo-relative
  "line": 88,                                     // the dispatch
  "job": "SendReceiptJob",                        // the job as written at the dispatch site
  "target": "Acme\\Jobs\\SendReceiptJob",         // resolved node id, or null
  "transactionLine": 84                           // the line that opened the enclosing transaction
}
```

A transaction hazard is a queued job dispatched from inside a database transaction that does not wait
for the commit. The queue does not roll back with the database, so a worker can run the job before
the rows it needs are committed ([13-glossary](13-glossary.md)). `engine/hazards.ts` finds them from
the markers a pack declares in its optional `hazards` block
([04-language-packs](04-language-packs.md) section 7), and a pack that declares none contributes
nothing here.

**It is a second axis and not a kind of edge**, which is why it sits at the top level beside `nodes`
and `edges` rather than in the edge list. An edge is a coupling between two nodes with evidence for
it; a hazard is a relationship between two coordinates in one file, where one end is a transaction
that is not a node at all and the enclosure is not a reference to anything. Modelling it as an edge
would have meant inventing a node for every `DB::transaction(` in the repository, and every count
`fanin` feeds would then be measuring something else.

**The key is always present, empty when nothing declares hazards.** Empty and absent are different
claims, and only the empty array can be printed: `empo query --hazards` has to be able to say that a
pack scanned for these and found none rather than falling silent, which is the same rule that keeps a
flow matching no node in `graph.flows` ([06-cli](06-cli.md)). A graph written before schema 3 has no
key at all, and that third state prints as unknown rather than as either answer.

**`hazardsScanned` is what makes an empty list readable**, and it is a second top-level field rather
than a count inside `stats`, because it is a list of languages and not a number. It records which
languages' packs declared hazard rules **at the moment this graph was built**, sorted. It has to be
recorded rather than looked up later, and the reason is the whole reason the field exists: hazards
are found at index time and stored, so a pack that grew its rules after this graph was written
collected nothing here. Asking that pack now would answer "this language looks for hazards" while the
stored empty list answers "and found none", and the two together state something no run ever
established. Recording the build's own answer makes a stale graph say "nothing looked", which is
true, and `empo index` is the repair. This is the one place the `resolvedBy` precedent does not
transfer: `--orphans` re-reads that field off the pack on disk because it only reclassifies nodes the
graph already holds, so the data is there either way.

**A hazard in this list is a dispatch nothing defers.** Two different facts remove a dispatch before
it lands here, and they are decided against two different texts. A `deferAtSite` marker on the
dispatch's own statement is decided during extraction, at the call site, where that statement is in
hand. A `deferAtDeclaration` marker is a claim by the dispatched job about every dispatch of it
anywhere, so it cannot be decided until that job's name has resolved to a node id. `engine/build.ts`
applies both when it assembles the list, and neither is recorded in the graph: what survives is a
hazard and what does not is simply absent. A dispatch whose job resolves to nothing therefore cannot
be deferred by declaration, which is the conservative direction: it stays in the list and a reader
goes and looks.

`target` is the dispatched job resolved to a node id, the way an edge target resolves: a qualified
name is a node id outright, and a bare one is matched against short names. Three things resolve to
null instead. A name that normalizes to nothing, a name no node carries, and a short name two nodes
share, that last one refusing to guess exactly as the `observer` strategy refuses
([04-language-packs](04-language-packs.md)). Null is then the honest answer rather than a reason to
drop the row, because a job named through a variable or built by a factory cannot be resolved and the
dispatch is still worth reporting: what makes it a hazard is the enclosure. It follows `edge.symbol`,
a present key with a null value rather than an absent one.

`file`, `line` and `transactionLine` are one file's coordinates by construction, because enclosure is
lexical: the engine compares character offsets inside a single source. That is also the axis's blind
spot, and [04-language-packs](04-language-packs.md) states it with the direction each failure runs
in. A dispatch inside a helper the transaction calls does not appear here at all.

Hazards are deduplicated across roots exactly as nodes and edges are, since two overlapping roots
re-scan one file and one dispatch site read twice is not two hazards, and they are sorted by
`(file, line, job, target)` through `compareStrings`, so this list is byte-stable like the rest of
the file.

**`schema` goes from 2 to 3 with this field.** A graph written by an earlier binary carries no
`hazards` key, and a reader that took a missing key for an empty list would report "found none" about
files nothing ever examined, which is the one answer this axis exists to prevent. `empo doctor`
reports the schema drift against the binary reading it, and the repair is `empo index`.

**`schema` goes from 3 to 4 with the meaning of `fanin`**, which has nothing to do with hazards and
is recorded here because this is where the rules for that number are written down. It is the plainest
case the number is defined for: the key kept its name and changed what it counts. Nothing else in the
file moved, so
a graph an earlier binary wrote is well formed, parses, and answers every fan-in question with the
old arithmetic while looking healthy. It is also the only signal a php-only checkout would ever get,
since its pack version did not move either. `empo doctor` reports the drift and `empo index` is the
repair, the same as above.

## Name resolution

```jsonc
{
  "family": "template",        // the edge family whose rules read the name; never "bridge"
  "resolved": 41,              // the name is in exactly one node, of a kind the rule accepts
  "unknown": 12,               // the name is in no node: a vendor component, a Blade `<x-slot>`
  "ambiguous": 7,              // the name is in several nodes, so no edge is emitted to any of them
  "wrongKind": 3,              // one node carries it, of a kind the rule's `targetKinds` excludes
  "ambiguousNames": [ { "name": "OrderTable", "nodes": 2, "references": 5 }, … ]
}
```

`names` holds one of these per edge family, sorted by family name. Only the `short-name` and
`observer` resolve strategies contribute, because they are the two whose entire input is a bare name
([04-language-packs](04-language-packs.md)). A `module-path` that resolves to nothing named a
package and a `fqcn` that does named a class in a vendor tree, and neither of those is a refusal a
repository can repair, so neither is worth a denominator. An ambiguous short name is.

**The field exists because the refusal was silent, and the silence was measured.** Both strategies
already declined a bare name carried by more than one node, and declined it without counting or
printing anything. On a synthetic 16-file React tree, adding a second `OrderTable.tsx` under a
second feature directory took the build from 12 template edges to 7, with no warning and with `empo
doctor` reporting OK; on a 640-file copy where every component name was 40-way ambiguous, not one
template edge resolved and the run looked exactly like a run against a repository that renders no
components. This field does not narrow the refusal, which is a separate and larger change: a family
that resolves nothing still resolves nothing. It now says so, which is what lets a reader tell
"found nothing" from "there was nothing to find".

**The counts are per reference, not per edge.** Two files rendering `<OrderCard />` are two resolved
references and, after `dedupeEdges`, two edges; one file rendering it twice is also two resolved
references and exactly one edge, because the dedupe key is `(from, to, kind)` and a second reference
between the same pair through the same family is the same coupling. So the two numbers are not the
same number and the record keeps the one that was read. The question it answers is what a family's
rules did with what they found, so the arithmetic has to be over what they found rather than over
what survived: a name written forty times that resolves is forty couplings the graph can carry, and
a name written once that does not is one missing edge.

**Tallied before edge deduplication, and deliberately.** An edge deduplicated away was still a
reference the rules read and resolved. Counting afterwards would shrink the numerator while leaving
every refusal standing, so a family with a heavy overlap between its imports and its renders would
report a yield lower than the one that was measured, and the ratio would fall for a reason that has
nothing to do with resolution. The same reasoning is why the counts are not deduplicated across
roots either: two overlapping roots that scan one file twice do read its names twice, which moves
numerator and denominator together, and `empo index` already names root overlap as the defect it is.

**Four verdicts and not one, because they call for four different reactions.** `unknown` is the
ordinary cost of reading a language whose vendor components are spelled exactly like local ones: a
JSX tag naming a package's component, a Blade built-in like `<x-slot>`. Nobody can act on it, and a
healthy typescript repository carries a lot of it. `wrongKind` is a rule's own `targetKinds` doing
precisely what it was declared for, refusing to land a tag on the one local `.ts` module that
happens to share a basename with a package (the Edge section above, and
[04-language-packs](04-language-packs.md) section 4, carry why that filter runs on the survivor of
the uniqueness test rather than before it). `ambiguous` is the only one of the three that hides a
coupling this repository really has: the name is in the graph, more than once, and the edge is
dropped in both directions rather than guessed at. `resolved` is the fourth because the other three
are unreadable without it: it is the numerator, and added to them it is the denominator, which is
why every surface prints the ratio on every run including the run where nothing was refused.
`41 of 41 resolved` and `0 of 53 resolved` are opposite results, and the total is the only thing
that separates them. A denominator that appears only in the bad case is one nobody learns to look
for.
Returned as a bare null downstream, as they were, all three failures were one fact, which is how a
family whose yield had gone to zero went on producing the same silence as a family with nothing to
find.

**`ambiguousNames` is what makes the count actionable**, and it is the one place the record cuts by
name instead of by reference. A number alone says the family is losing edges; this says which rename
would give them back. `nodes` is how many nodes carry the name, never fewer than two, and
`references` is how many reads named it and got nothing. The list is sorted by `references`
descending, then `nodes` descending, then the name, so the entry a reader saves the most edges by
repairing is the one they read first, and the name is a tiebreak rather than a preference: two
entries that cost the same have to order the same on every machine or `graph.json` stops being
byte-comparable.

**Merging across roots sums the counts and takes the MAX of the candidate counts.** Two references
read under two roots are two references, so `resolved`, `unknown`, `ambiguous` and `wrongKind` add.
`nodes` does not, and the asymmetry is not an oversight. Ambiguity is decided against one root's
node index: a name refused under `apps/portal` was weighed against `apps/portal`'s three files and a
name refused under `apps/admin` against that root's two, and no single refusal ever looked at five.
Summing them would print `5 files` for a name a reader will never find five of anywhere, and would
send them hunting for two files that do not exist. The larger of the two is the index they will
actually find the most copies in, and it is the number the worst refusal weighed.

**Absent and empty are different claims, and the distinction is sharper here than it is for
`hazards`.** An empty list means a build counted and nothing read a bare name, which has two causes
and the record does not separate them: the configured roots' packs declare no `short-name` and no
`observer` family at all, or they declare some and none of them matched a file. EmPo's own
repository is the second — its typescript pack's two `short-name` template rules carry
`pathGlob: "**/*.{tsx,jsx,vue}"`, which matches nothing in a repository with no components in it —
and a surface that reported "these packs resolve no names" over it would be inventing a fact about
the pack out of a fact about the tree. So the empty list is a real answer this field can carry, and
the sentence printed over it claims only what was counted. An absent key means nobody counted: the
graph was written before schema 5. `readGraph` therefore leaves the key exactly as parsed, missing included, the same way it
leaves `hazards` and unlike `hazardsScanned`, which it does coerce because absent and empty are one
claim there. What makes it sharper: `hazards`' third state is a reader being told "found none" about
files nothing examined, which is one wrong answer among the axis's answers. Here the wrong answer is
the exact silence the field was built to end. A reader that defaulted the missing key to `[]` would
print "no name-resolving rule read a name here" over a repository whose template family may have
collapsed to zero, which is the pre-schema-5 behaviour reproduced inside the field that exists to
prevent it. So every surface prints the absence as unknown, and `empo index` is the repair. Pack
fixture snapshots deliberately do not follow this rule and do default a missing `names` to `[]`: a
snapshot is regenerated from a corpus this repository owns, so the counts arriving read as a diff
somebody reviews rather than as an answer served about somebody's code.

**`schema` goes from 4 to 5 with this field**, and it is 3's case rather than 4's. 4 was a key that
kept its name and changed what it counts, which no reader can detect; 3 was a field that arrived,
and a field that arrives announces itself only where its absence and its emptiness mean the same
thing. Here they do not, so the bump carries the whole of the announcement: without it a graph
written by an earlier binary would parse, look well formed, and answer the one question the field
was added to answer with a fact no run ever established. `empo doctor` reports the schema drift
against the binary reading it, and `empo index` is the repair, the same as above.

`names` is not a health finding and never becomes one. An ambiguous component name is the normal
shape of a React tree with feature directories, and a `TextInput` under two namespaces is the normal
shape of a Blade component library, so a warning on it would fire forever on a deliberate state and
be turned off. The number is the whole of the answer; whether it is the right number is the reader's
judgement.

## What the graph deliberately does not contain

Documented so nobody mistakes absence for safety:

- **Docblock / type-annotation references.** A `@property Foo` is a type hint, not a call. Counting
  those makes fan-in mostly noise, so they are excluded.
- **Runtime-assembled class names.** A name built from fragments the parser never sees together is
  invisible. No regex tool can see it.
- **Pure database-table or string-event coupling** that no pack rule captures. If two files talk
  only through a shared table and no symbol rule models it, there is no edge.
- **A dispatch a transaction reaches through a helper.** Hazard enclosure is lexical, so the two
  coordinates have to sit in one file. A transaction closure that calls `$this->finalise($order)`,
  with the dispatch inside `finalise()`, is exactly the shape the axis exists to catch and exactly
  the shape it cannot see.
- **Logic duplication.** The most dangerous absence: a flow that reimplemented the shared logic
  instead of importing it has no edge to the shared code, so it looks safe and is not. `empo query`
  cannot see this; the review discipline's "read the absences" step
  ([07-review-discipline](07-review-discipline.md)) exists precisely to catch it by hand.

The contract to the user, printed by `empo query`: **treat the flow list as a floor, not a
ceiling. Absence of evidence is not evidence of absence.** When a change smells wider than the
graph says, grep and confirm.

## Determinism and size

`empo index` is deterministic: same source plus same pack versions produce a byte-identical
`graph.json` (nodes sorted by id, edges sorted by `(from, to, kind, evidence.line)` with the
evidence file breaking the last tie, since an edge has no id to sort on, hazards sorted by
`(file, line, job, target)` for the same reason, `names` sorted by family with each
`ambiguousNames` sorted by cost and tie-broken on the name, and no timestamps except
`builtAgainst` which is a content-derived git sha). This makes the file diffable and makes "did the
graph actually change" answerable. For very large repos the file can be sharded
(`generated/graph/*.json` with a manifest) without changing the logical schema; that is an
optimization, not a v1 requirement.
