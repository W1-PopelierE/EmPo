# Map discipline

This is the workflow `empo init` hands you after it prints the facts: the roots it detected and the
language of each, the graph it has just built, the kinds in that graph, the directories holding the
most nodes, the code nothing in the graph references, the code the most things reference, the
http-route symbols the API produces, and the repair-verb names that hint at a spine. This file is
the procedure you run over them.

You are proposing two artifacts and you own neither. `flows.json` is the end-user journeys the graph
joins to its nodes, and it is the one input to the graph a human owns. A spine is the map of one
critical chain, and most repositories warrant none. Both come back as a proposal for a human to
approve, never as a fait accompli.

One rule governs all of it: **propose nothing you have not read.** A flow inferred from a directory
name and a `file:line` reconstructed from memory fail in the same way, quietly, inside an artifact
every later reader treats as ground truth.

## The pipeline

```
0. read what init printed   roots, languages, kinds, directories, entrypoints, routes, blast radius
1. flows first              the journeys someone outside engineering would recognize
2. a spine, usually none    four signals, and zero or one is the normal answer
3. draft only what you read hops, guarded globs, traps, terms; never an invariant you cannot cite
4. cite every coordinate    file, line, and an anchor copied out of the open file
5. write one json document  strict, at the path init named
6. hand it to the gate      empo init --proposal, then --apply, then it belongs to the humans
```

## 0. The evidence is already on your screen

`empo init` detected the roots, built the graph, and printed what it found before it handed you this
file. Three of its sections answer most of the flow question, and you read them before you open a
single source file:

- **Produced http-route symbols.** Every route the API declares is a door a user walks through, and
  a journey usually starts at one.
- **The graph's kinds.** The language pack has already sorted the repository into `route-file`,
  `model`, `job` and the rest, which is a faster read than the file tree.
- **The `structure` section.** Not a top-level listing: it is every directory that holds a node,
  at whatever depth it sits, ranked by how many nodes it holds. This is where the product's own
  vocabulary shows up in path names, and those names are the ones the business already uses.

Two more sections are answers you would otherwise go hunting for, so read them there rather than
running a command for them. `entrypoints` is the code nothing in the graph references, and `widest
blast radius` is the code the most things reference, which is what `empo query --gods` ranks. Every
section of the brief stops at twelve rows and says how many it held back, so the query is worth
running when a section was truncated.

Read `entrypoints` knowing what it already did to the list, because the row that matters most to
you is the one it ranked and not the one it dropped. A row marked **`arrived by user`** is a kind
the pack says somebody outside the code arrives at: a route file, a console command, a Livewire
component. Those come first, and each is a place a journey starts, which is the same claim the
produced routes make one section down. Behind them come the kinds the pack makes no claim about,
which is the plain "nothing references this". What is missing is counted in a line under the
section: the kinds a pack marks framework-resolved and nobody arrives at, a view rendered by a
controller the user already reached, a migration a deploy runs. Shared machinery a journey passes
through is not itself a journey, and that subtraction is how you tell the two apart.

`empo query --orphans` is still worth running, and it answers a different question of the same set:
it asks "is this dead?" where the brief asked "does a journey start here?", so it keeps every
unclaimed row and drops every framework-resolved one, route files included. `--blind` is the answer
you cannot have yet, because it is computed per flow and there are no flows until the human approves
yours.

## 1. Flows

A flow is one end-user journey, named the way the business names it: "Place an order", "Confirm a
checkout", "Review orders in the back office". Its `paths` are repo-relative path prefixes, not
root-relative ones, so a single journey spans the API and the app, which is the whole reason flows
exist in a monorepo. A prefix matches only at a path boundary, so `app/Models/Order` claims
`Order.php` and everything under `Order/`, and never claims `app/Models/OrderLine.php`. `label` is
optional; write it anyway, because it is the sentence a human reads in a blast-radius answer.

Expect a handful. A journey is something a person does, and a product has fewer of those than it has
directories.

Three proposals are wrong before anyone reads the code:

- **One flow per directory.** `models`, `controllers`, `observers`, `services`. That is a directory
  listing wearing a different file extension. The graph already holds the directory structure; a
  flow that repeats it answers no question that `ls` did not.
- **A flow nobody outside engineering would recognize.** A flow name is printed to argue that a
  change matters to somebody. "Confirm a checkout" ends that argument and `middleware` does not.
- **A flow whose paths cover the whole repository.** `apps/api` as a path owns every node beneath
  it, so every query reports that flow, and the blind-flow list, the single most valuable answer
  EmPo gives, stops discriminating between anything. A flow that owns everything separates nothing.

Every path is checked against the graph before it survives. A path that matches no node is dropped
and the verdict says which of the three mistakes it was: a directory that is not there at all, which
is you inventing one; a directory whose every node in the graph is a test, because no test node is
ever assigned to a flow and a path over a test tree therefore owns nothing; or a directory that is
there and holds no node at all, which means the graph is stale or that tree sits under no configured
root. The third is worth telling the human rather than quietly deleting the path. A flow left with
no surviving path is dropped whole, so padding a flow with paths you hope exist costs you the flow.

So name the code a journey runs through, never the tree its tests live in.
`app/Http/Controllers/CheckoutController.php` is where the checkout happens and
`tests/Feature/Checkout` is where somebody checked it, and only the first is a path a flow can own.
Coverage asks whether a test reaches the flow's code, and a flow made of tests is asking that
question about itself.

A name `flows.json` already defines is reported as a change for the human to make, and the entry on
disk stands. That file is theirs, and a proposal never merges into it.

## 2. A spine, and usually there is none

A spine maps one chain where an error entering at one hop is carried forward and detected at none,
until it reaches somewhere irreversible. Money is the archetype. Auth and tenant isolation are
others. The test is not complexity: a parser is complicated and fails loudly, a ledger is simple and
fails silently, and only the second one earns a spine. **A spine is warranted where being silently
wrong is expensive, not where the code is merely hard.**

Most repositories have zero or one. A spine is expensive to curate, it drives a commit gate, and
every one of them is a promise that a human will keep it current. An agent that proposes four spines
has understood none of that: it read the signals as "this module looks important" rather than "a
wrong value here is copied forward and asserted nowhere". Propose one, or propose none, and say
plainly which chain you rejected and why. A rejected candidate with a reason is useful to the human;
a fourth spine is not.

### The four signals, and what the graph can actually see

- **Tombstone commands.** A repair or regeneration script (`fix-duplicate-invoices`,
  `regenerate-ledger`, `recalculate-totals`) is a grave marker: production data was wrong, and
  somebody wrote code to put it back. Nobody writes one speculatively, so a cluster of them over one
  module is the strongest of the four. The graph hints at this one, because names and paths are in
  it. It cannot decide it: whether a script repairs data or merely seeds it is in the body, so open
  the body.
- **Value columns.** Money and decimal columns are the data the chain moves, and they tell you which
  table the chain ends in. The graph cannot hint at this at all. It holds symbols and edges, not
  column types, so you read the schema definition and the migrations yourself.
- **Idempotency machinery.** Unique constraints, `processed_at` flags, dedupe keys, advisory locks.
  They cluster exactly where a duplicate would be catastrophic, which is where a spine runs. The
  graph cannot hint at this either, for the same reason: a constraint lives in a migration, and a
  migration is not a symbol.
- **An existing integrity check.** A scheduled job that recomputes totals and compares them is the
  invariant list, already written and already executable. This is the best thing you can find. Where
  the pack has a kind for a queued job the graph puts the candidates in front of you; whether one
  recomputes and compares is in its body.

The split is worth being honest about: two of the four the graph hints at, none of the four it
decides, and two of them it cannot see at all. Name the signals you actually observed, in the
spine's `principle` or in a hop `note`, so the human approving it can check your reading instead of
trusting it.

## 3. What you draft, and what you must leave alone

You draft the map: `principle`, `hops` in chain order with `n` strictly ascending, `guarded`,
`assertionTerms`, `assertionPaths`, `traps`, and the `flows` the chain reaches.

**Keep `guarded` narrow.** It is a commit gate, not a description of the module. It matches three
ways, as a glob if it holds any of `*?[]{}!`, as an exact file path, or as a directory whose whole
subtree is guarded, and all three forms match dotfiles. Guard the files the value passes through. A
gate that fires on changes which cannot move a number is a gate the team learns to route around, and
a routed-around gate protects nothing.

**Take `assertionTerms` from tests that exist.** A spine whose `guarded` is non-empty must declare
at least one term, and the schema refuses the pair rather than shipping a gate no change could ever
satisfy. Read the tests that already cover the chain and copy the shape they assert with
(`assertSame(`, `->assertMoney(`, `cents`). A helper the repository does not have is a gate nobody
can pass.

**Name the test files in `assertionPaths`, from the same reading.** Without it the gate accepts an
assertion added to any test file in the change, including one about a different feature entirely,
which passed a real commit that changed the rounding of a guarded money calculation. List the test
files and directories you actually read while tracing the chain, in the same three forms `guarded`
takes. Propose it only from files you opened: a path invented here narrows the gate onto a test that
does not exist, and the whole spine then fails every change it sees. Leave the field out where you
did not read the tests, which is the honest answer and is the behaviour every spine had before it.

Two things are not yours:

- **Invariants you cannot cite.** Propose an invariant only where the codebase already checks it and
  you can point at the check: a test, a scheduled integrity job, a lint rule. State it in the
  smallest exact unit the code uses, cents rather than "the amount". The invariants that are true
  and that nothing checks are the valuable ones and they are the human's to write, because writing
  them from the code is exactly the act of inventing them.
- **`assertableAtWriteTime`.** Leave the field out of every invariant you draft. It defaults to
  false, which reads correctly as "nobody has judged this yet". Deciding that a nightly check could
  move into the write path takes someone who knows what that path already costs.

## 4. Cite every coordinate

This is the rule that decides whether your proposal survives, so it gets its own step.

Every `file:line` in a spine, on a hop, on a trap, on an invariant's citation, carries an `anchor`:
a distinctive substring really present at that line. The gate resolves each anchor against the real
file, three ways:

- The anchor is on the cited line. Verified, and it goes through untouched.
- The anchor is elsewhere in the file. The line number is corrected silently and the spine lives,
  because a coordinate that is four lines off is a stale number, not a fiction.
- The anchor is nowhere in the file, or the file cannot be read, or the path escapes the repository.
  **The entire spine is dropped, and named in the verdict.** Not the hop. The spine.

The severity is deliberate. A spine is a map somebody reads to locate themselves before touching a
chain where mistakes are expensive. One invented coordinate turns every other coordinate in the file
into a question, and a map that has to be re-verified before use is worth less than no map. So a
single fabricated line costs you the whole proposal, including the hops you got right.

The defence costs seconds. Open the file, find the line, copy the text out of it. Never reconstruct
a line from what the function probably looks like, and never tidy it while copying. Whitespace is
collapsed before the comparison, so a reindent cannot fail you, but a renamed variable will. Pick
something distinctive: `return $order->subtotal + $this->tax(` is an anchor, `{` and `return` are
not, and an anchor matching forty lines gets corrected to the wrong one of them.

Every path is repo-relative. The anchors that survive are re-resolved by `empo verify` on every
session afterwards, which is what keeps a hand-curated file honest long after you are gone.

## 5. Write one JSON document

Write the proposal to the path `empo init` named, in this shape:

```json
{
  "version": 1,
  "flows": {
    "checkout": {
      "label": "Checkout",
      "paths": ["apps/api/app/Http/Controllers/CheckoutController.php"]
    }
  },
  "spines": []
}
```

`flows` maps a flow name to its definition. `spines` is an array of whole spine files, and each
one's `name` is the file it becomes, `.empo/spines/<name>.json`, which is the rule every spine
follows: the file name is the spine name, because that name is what every report and every gate
message prints. So a name is one plain word, and one that would write somewhere other than that
directory is refused.

The document is strict. An unrecognized key is refused with the key named, never silently dropped,
so a misspelled `unguarded_flows` or `assertionTerm` becomes a message instead of a field that
quietly does nothing. `flows` and `spines` both default to empty, and **proposing nothing is a
legitimate answer**: a repository with no journey worth naming and no chain that fails silently is
better served by an empty `flows.json` than by six invented ones.

## 6. A spine skeleton

One entry of `spines`, for the fictional `acme-platform` monorepo, kept to the three hops that carry
the value:

```json
{
  "version": 1,
  "name": "pricing",
  "principle": "The subtotal is copied forward from the controller to the app and nothing between them recomputes or asserts the total.",
  "hops": [
    {
      "n": 0,
      "title": "the subtotal enters the chain",
      "entry": "OrderController::store",
      "file": "apps/api/app/Http/Controllers/OrderController.php",
      "line": 15,
      "anchor": "return $prices->total($order);",
      "note": "the only place a cart becomes an order total"
    },
    {
      "n": 1,
      "title": "total resolution",
      "entry": "PriceCalculator::total",
      "file": "apps/api/app/Libraries/Price/PriceCalculator.php",
      "line": 13,
      "anchor": "return $order->subtotal + $this->tax(",
      "note": "sole funnel: every total the api returns is produced on this line, in whole cents"
    },
    {
      "n": 2,
      "title": "the app renders the total",
      "entry": "formatMoney",
      "file": "apps/mobile/src/shared/money.ts",
      "line": 4,
      "anchor": "(money.cents / 100).toFixed(2)",
      "note": "cents become a float here, across the http-route bridge, and no test compares the two sides"
    }
  ],
  "guarded": ["apps/api/app/Libraries/Price/**", "apps/mobile/src/shared/money.ts"],
  "assertionTerms": ["assertSame(", "cents"],
  "assertionPaths": ["apps/api/tests/Feature/OrderTest.php"],
  "invariants": [
    {
      "id": 1,
      "statement": "total(order) equals order.subtotal plus tax on that same subtotal, in whole cents",
      "citation": {
        "file": "apps/api/tests/Feature/OrderTest.php",
        "line": 15,
        "anchor": "assertSame(1210,"
      }
    }
  ],
  "traps": [
    {
      "what": "tax is integer division on basis points, so the remainder is dropped once per call, and splitting a total into lines and adding them back does not give the same number",
      "file": "apps/api/app/Libraries/Price/PriceCalculator.php",
      "line": 18,
      "anchor": "intdiv($subtotal * self::TAX_RATE_BASIS_POINTS"
    }
  ],
  "flows": ["checkout", "orders"]
}
```

Read what is absent as carefully as what is there. There is one invariant, and it is there only
because a test already asserts it and the citation points at that test; the prose invariants this
chain obviously needs are left for the human, and no invariant carries `assertableAtWriteTime`.
`unguardedFlows` is empty because nothing can compute it yet: it is the coverage answer, and
coverage is per flow, so it exists only after these flows are approved and indexed. `moneyType` is
there for a money chain and is left out rather than guessed at.

## 7. The verdict, then the handover

Run the gate and read what it says:

```
empo init --proposal <path>              # the verdict, writes nothing
empo init --proposal <path> --apply      # writes only what survived
```

The verdict names every flow, every path that matched nothing and which of the three mistakes it
was, and every spine that was dropped along with the coordinate whose anchor dropped it. Corrections
are the one thing it counts instead of naming: each spine's line ends in `<n> corrected`, and which
citations moved and what line they moved to is not printed anywhere. So a count above zero is your
cue to open the spine and read the coordinates it now carries, because those line numbers changed
under you and the corrected file is the one a human is being asked to approve. It exits 0 either
way, because a proposal is a suggestion and only the mechanical gates fail a build. A dropped spine
is repaired by opening the file the anchor claims and reading it, never by trying a different
substring until one sticks.

Nothing reaches `.empo/` until a human approves it, so `--apply` runs on their say-so and not on
yours. What it writes is a starting point: the human renames flows into the words their team uses,
merges the two you split, prunes the ones that map a directory rather than a journey, and fills in
the invariants you were right not to invent. From that moment `flows.json` and `spines/*.json` are
human-owned, hand-edited artifacts, and everything EmPo answers afterwards stands on them.
