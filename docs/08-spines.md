# 08. Spines

A spine is a hand-curated map of one critical chain in a codebase: a sequence of hops where an
error entering at one hop is carried forward and detected at none, until it reaches somewhere
irreversible. Money movement is the archetype (a charge that flows contract -> claim -> invoice ->
payment -> ledger -> external export, copied forward at every hop, asserted at zero of them). Auth
and tenant isolation are others (a permission decision that flows through a guard, a policy, a
scope, a query, where one wrong hop leaks another tenant's data).

The graph ([05-graph-model](05-graph-model.md)) tells you **what** connects to what. A spine tells
you **what must still be true** after you change one of those connections. They are complementary:
the graph is generated and cannot see invariants; the spine is curated and cannot see the whole
consumer list. `empo query` gives you the blast radius; the spine gives you the contract.

Most repos have zero or one spine. A spine is expensive to curate and only worth it where a wrong
value is irreversible and silent. Do not create spines speculatively.

## Why a spine is curated, not generated

The single structural property that makes a critical chain dangerous is not visible to a dependency
graph: **every hop trusts the previous hop, and nothing asserts the total still holds.** That is a
statement about invariants and about what is *not* checked, and absence is exactly what a generated
graph cannot represent. So a spine is written by a human (proposed by an agent, approved by a
human), and kept honest by drift detection rather than by regeneration.

The core principle a spine enforces: **a value is not correct because the code ran. It is correct
because something asserted it, in a test, in the smallest exact unit (cents, not floats).** A change
touching a spine is not done when it works; it is done when a value is asserted.

## Spine file schema

`.empo/spines/<name>.json`. The file name is the spine name: `spines/orders.json` declares
`"name": "orders"`. That is the same rule a language pack lives under, and for the same reason: the
name is what every report, every gate message and every hook prints, so a file whose name says
something else leaves a human hunting for a spine that does not exist under that name.

A spine is strict JSON, like `config.json` and `flows.json`. The example below is annotated for
readability only; a real spine carries no comments, and the `note` fields are where prose lives.
`version` is required for the same reason those two files carry one: `empo update` migrates a schema
forward and cannot migrate a file that will not say what it is. Every field name is camelCase, so
`unguardedFlows` and `moneyType` are spelled the way `assertionTerms` and `assertableAtWriteTime`
already were, and the way every other EmPo artifact is. The validator is
`src/schema/spine.schema.ts`; a spine that breaks any rule below is refused at load with the file
named, because a malformed spine that loads silently gates nothing. An unrecognized key is refused
too, rather than ignored, which is what turns a misspelling (`unguarded_flows`, `assertionTerm`) into
a message instead of into a field that quietly does nothing.

The example is the fictional `acme-platform` monorepo (a PHP API under `apps/api`, a TypeScript app
under `apps/mobile`, and the Inertia pages the API renders under `apps/portal`) that `examples/` and
the pack fixtures use. Every spine that ships with EmPo is
invented, for a fictional domain, and labeled as such: see
[11-security-boundaries](11-security-boundaries.md).

```jsonc
{
  "version": 1,
  "name": "orders",
  "principle": "Every hop trusts the previous hop's total; nothing recomputes it.",

  "hops": [
    {
      "n": 0,
      "title": "order intake",
      "entry": "OrderController::store",
      "file": "apps/api/app/Http/Controllers/OrderController.php",
      "line": 15,
      "anchor": "return $prices->total($order)",
      "note": "the only place a cart becomes an order total"
    },
    {
      "n": 1,
      "title": "subtotal -> total",
      "entry": "PriceCalculator::total",
      "file": "apps/api/app/Libraries/Price/PriceCalculator.php",
      "line": 11,
      "anchor": "public function total(",
      "note": "sole funnel: every total in the platform is produced here, in integer cents"
    }
    // … one entry per hop, each with its own anchor
  ],

  "guarded": [                       // empo check fails a change here with no value assertion
    "apps/api/app/Libraries/Price/**",
    "apps/api/app/Models/Order.php",
    "apps/api/app/Observers"
  ],

  "assertionTerms": ["assertSame", "->assertMoney(", "cents"],   // what counts as a value assertion here

  "assertionPaths": [                // and where. omit it and any test file in the diff counts
    "apps/api/tests/Feature/OrderTest.php",
    "apps/api/tests/Unit/Price"
  ],

  "invariants": [
    {
      "id": 1,
      "statement": "order.total equals order.subtotal plus tax, in integer cents, for every stored order",
      "assertableAtWriteTime": true,
      "citation": { "file": "apps/api/tests/Feature/OrderTest.php", "line": 15,
                    "anchor": "assertSame(1210" }
    },
    {
      "id": "INV-2",
      "statement": "confirming a checkout never changes an order's total"
    }
    // … one per invariant. the executable spec, if one exists, is the best source.
  ],

  "traps": [
    {
      "what": "tax is integer division on basis points, so the remainder is dropped once per call; splitting a total into lines and adding them back does not give the same number",
      "file": "apps/api/app/Libraries/Price/PriceCalculator.php",
      "line": 18,
      "anchor": "intdiv($subtotal * self::TAX_RATE_BASIS_POINTS"
    },
    {
      "what": "the summary cache is refreshed from the saved event, so a total written by a bulk update never reaches it",
      "file": "apps/api/app/Observers/OrderObserver.php",
      "line": 9,
      "anchor": "public function saved("
    }
  ],

  "flows": ["admin", "checkout", "orders"],
  "unguardedFlows": ["admin", "checkout"],   // reach the chain but have no value-asserting test

  "moneyType": {
    "class": "Acme\\Money\\Cents",
    "note": "integer cents, never a float. A total is a whole number of cents at every hop."
  }
}
```

### Fields

- **hops**: the chain, in order, each with a `file:line`, an `anchor` and a note. This is the map you
  read to locate yourself before changing anything, so a hop's coordinate is checked exactly like a
  trap's or an invariant's: the anchor is required on every hop, and a hop nothing can resolve is
  the precise fiction `empo verify` exists to catch. `n` must strictly ascend in array order. The
  array is the chain in order and `n` is the label a human cites ("hop 3 is the sole funnel"); if
  the two disagree, two readings of one spine disagree.
- **guarded**: repo-relative patterns that `empo check` watches. A change touching these with no
  added test line using `assertionTerms` fails the gate. "What `empo check` matches" below states
  exactly which entries match which files.
- **assertionTerms**: what counts as a real value assertion *for this spine*, narrower than the
  pack's language-wide default. A money spine wants amounts in cents; asserting a 200 does not
  count. A spine whose `guarded` is non-empty must declare at least one term: a gate no change can
  satisfy fails everything it sees and is uninstalled within a day, so it is refused at load rather
  than discovered in a hook.
- **assertionPaths**: *where* such a line has to be added for it to count, in the same three forms
  `guarded` is written in. Optional, and empty means anywhere in the diff the language pack calls a
  test, which is what every spine did before this field existed. It exists because that default is
  satisfiable by a test with nothing to do with the change: a commit changing the rounding of a
  guarded money function passes on the strength of an added assertion in a theme test that imports
  nothing from pricing. Name the tests that speak for this chain and the
  gate is held to them. The two scopes **intersect**, so a spine's paths can only ever narrow what
  counts and never widen it: a wide or misspelled glob costs its author a gate that is hard to
  satisfy, which is visible the second it happens, rather than one that waves a change through,
  which is visible to nobody.
- **invariants**: what must still be true. If the codebase already has an executable specification
  (a scheduled integrity check, a linter, a test), cite it: an executable invariant is better than
  a prose one. `citation` is optional, because a prose invariant cites nothing rather than inventing
  an anchor, and an invented anchor is the one thing this file may never carry. `id` is a number or
  a string label, whichever the team already cites them by. Each records whether it is assertable at
  write time, defaulting to false, because the best fix moves a check from a nightly cron into the
  write path and claiming a check can move there is a judgement, not a default.
- **traps**: verified gotchas with a `file:line` and an `anchor`. The anchor is what drift
  detection resolves.
- **flows / unguardedFlows**: the consumer flows the chain reaches, and which of those have no
  value-asserting test. `empo query` derives the second list from coverage; the spine records the
  human-confirmed version.

## Citations and drift detection

Every `file:line` in a spine also carries an `anchor`: a distinctive substring expected at (or very
near) that line. `empo verify` resolves each anchor against current source, three ways:

- Anchor on the cited line: verified.
- Anchor somewhere else in the file: soft drift, and the report prints the line to set. The nearest
  match wins, ties going to the lower line number, so the suggestion never depends on the order the
  file was read in.
- Anchor nowhere in the file, or the file is unreadable, or the path escapes the repository root:
  hard drift, and the note says which. The `file:line` is now fiction and every claim resting on it
  is suspect until a human looks.

**Both soft and hard drift exit 1.** A coordinate that is quietly five lines wrong misleads every
reader who trusts it just as surely as one that points nowhere; what differs is the repair, which is
why the two are printed apart and only the soft ones carry a line to set. The acceptance criterion is
the same for both: `empo verify` detects a deliberately moved anchor as drift and exits non-zero.

The resolver is `src/engine/citations.ts`, the same one the review gate runs over a finding
([07-review-discipline](07-review-discipline.md)), so a spine's coordinate and a finding's
coordinate rot in exactly the same visible way, and one checker answers for both.

The generated SessionStart hook warns on drift, so a rotted spine announces itself instead of
silently misleading the next change ([10-distribution](10-distribution.md)). Where the wiring is not
installed, that is `empo verify` run by hand or in CI. Either way, this is what makes a hand-curated
artifact trustworthy over time: not that it never rots, but that rot is detected.

## What `empo check` matches

`empo check` is the commit gate ([06-cli](06-cli.md)). Its subject is the staged diff by default,
or the changes against `--base <ref>` in CI. What it looks for is mechanical, and worth stating
exactly, because a gate whose answer a human cannot predict is a gate people learn to route around.

A `guarded` entry matches three ways: as a glob if it holds any of `*?[]{}!`, as an exact file path,
or as a directory whose whole subtree is guarded. All three, because all three get written by hand
into that one field, and requiring `/**` on a directory would leave a spine that names a single file
silently guarding nothing at all.

All three forms match dotfiles and dot-directories. Nobody writing `config/**` means "except the
dotfiles", and `.env` is exactly the sort of file whose change moves a number, so the glob form
guards what the directory form guards. This is deliberately unlike the source scanner, which skips
dot-directories: the scanner decides what the graph holds, and a guarded pattern is matched against a
diff, which carries every path git staged.

**A rename is matched on both of its paths.** A change that moves a guarded file has two spellings
and only one of them is under the guard, so the gate asks its patterns about the pre-rename path as
well as the new one. Without that, `git mv` out of a guarded tree carried a logic change with it and
the gate reported that none of its guarded files had been touched. The verdict even inverted with
the size of the edit, because git records a move it can no longer recognize as a delete plus an add
and the delete half carries the old path, so the small edit escaped where the large one was caught.
A touched file is named by the spelling the spine claims, and where that is the old one, the report
says where the file went: `src/pricing/money.ts -> src/util/money.ts  (moved out of the guarded
tree)`. A rename **into** a guarded tree is guarded from that commit on, and one within it is
reported under the name the author now opens.

Only *added* lines count as an assertion. An assertion that was already there is evidence about the
change that added it, not about this one.

An added line counts only if it is in a test file, and "test file" is answered by the language pack's
`tests.paths`, so the gate's idea of a test is the same one the graph's `isTest` and the blind-flow
computation use ([05-graph-model](05-graph-model.md)). If no installed pack declares any test path,
an assertion term counts anywhere in the diff, and the command prints that it had to rather than
reporting a pass it cannot stand behind.

**A spine that declares `assertionPaths` is held to those files as well.** The two scopes intersect,
never replace: a file counts when the pack calls it a test *and* one of the spine's patterns claims
it, matched exactly as a `guarded` pattern is. A spine that declares none is scoped by the pack
alone, which is a real and common configuration and is why the gate says so. `empo check` prints a
second caveat for exactly those answers, that the added line may be in any test file the change
touches including one with nothing to do with the guarded file, and withholds it once every spine in
the answer names its own tests. Three surfaces render the same sentence from one helper, so the
pre-edit warning, the review brief and the gate's own failure cannot tell an author three different
things about what would satisfy the same spine.

The spines are read from disk and the diff is only ever the subject, so unstaging the spine file
cannot dodge the gate.

The gate sees that a value-asserting line was added, never that it asserts the right value. Reading
the test is still the reviewer's job, and `empo check` prints that caveat with every answer, pass or
fail.

`--bypass "<reason>"` is the explicit human override, and it takes a reason instead of being a bare
flag. That is what "bypassable only explicitly" means in practice: deciding a change genuinely
cannot affect a value is a human's call, and it goes on the record where the next reader sees it.

## What a review reads in a spine

`empo review`'s brief names the spines a change is on, among the facts it prints before the shipped
discipline ([06-cli](06-cli.md), [07-review-discipline](07-review-discipline.md)). That is the third
place a spine is read on behalf of a change, after `empo check`'s commit gate and the pre-edit hook
that asks the gate's question one file at a time. `empo verify` and `empo doctor` read one too, but
they ask about the map's own health and not about a diff.

A spine surfaces there for **three separate reasons, reported separately**, because they ask the
reviewer for different work:

- A changed file a `guarded` glob claims. That is exactly the gate's subject, so it is also the
  advance notice of what `empo check` is about to want.
- A changed file a hop or a trap cites. `guarded` need not cover these, and often does not.
- A flow the blast radius reaches that the spine lists in `flows`. That is the spine's own claim
  about the chain meeting the graph's claim about this change.

**The review's question is wider than the gate's, deliberately.** `empo check` asks only about
`guarded`, because it fails a commit and may only fail on a rule its author wrote down. `guarded` is
curated to be gateable, and a chain runs through files nobody wants gated, so the hop file outside
`guarded` is the commonest of the three signals and would be wrong to gate on. A review is read by
somebody who can weigh a weak signal and decide it is nothing, which is a judgement a hook does not
get to make.

What the reviewer does with each part of the file:

- **Hops locate you.** Read the chain before the diff and you know which hop the change sits on,
  what hands it a value and what it hands one to. A hop whose file the diff changes is marked
  `CHANGED BY THIS DIFF`, so the map says where you already are.
- **Invariants are the contract.** They are what must still be true once the change lands, and they
  are the questions to ask of the diff. One with no citation is marked
  `PROSE ONLY: nothing asserts this, so only reading catches a break`, because an invariant nothing
  executes is one only a reader can defend.
- **Traps are verified gotchas.** They are the places where the obvious change is wrong, already
  paid for once by somebody. A trap is worth reading whenever the change is anywhere near its file,
  and worth citing in a finding when the change walks into it.
- **`assertionTerms` set the standard for coverage.** A reached flow the spine also names in
  `unguardedFlows` is marked `UNGUARDED`: the spine records that no test asserts a value there, so a
  wrong number ships silently. Only the flows printed above it are marked, which is one more reason
  every entry in `unguardedFlows` belongs in `flows` as well. When a `guarded` file changed, the
  brief also prints the terms `empo check` will look for on an added test line.

That last one is where "What `empo check` matches" above hands over. The gate sees that a
value-asserting line was added, never that it asserts the right value, and reading the test is still
the reviewer's job. The brief is where that job is handed over with the material to do it: the
chain, the invariants the value has to satisfy, and the exact terms that count here.

**The spine is read from the reviewer's checkout, and its coordinates are resolved against the read
root.** On a pull request those are two different commits, and that is the point. The map is the one
the team curates; the code it is checked against is the code the change proposes. So a pull request
that moves a hop's anchor reports drift inside the review, which is the earliest anyone can be told,
and long before the merge that would make the map wrong for everybody. Reading the spine out of the
worktree instead would let one change edit the map and the chain together and report itself as
consistent. A local review has one root and one commit, and so does a pull request whose worktree
could not be created, which the brief says in its notes rather than leaving the reader to assume the
stricter reading.

**Drift is reported per coordinate, and no count is printed above them.** The reader opens these one
at a time, and a summary tells them the wrong thing about the one in their hand. The asymmetry is
the one the findings gate already runs on: an anchor that moved is printed at the line it is really
on, with the line the spine claims alongside it so the repair is visible, and it is still worth
reading. A hard-drifted one, meaning the anchor is nowhere or the file is gone, is printed as the
spine wrote it and labelled `ANCHOR NOWHERE: do not trust this coordinate, run empo verify`, because
there is no better line to offer and printing it quietly is the one thing this tool exists not to
do.

Only the touched spines are verified. Resolving every coordinate of every spine would spend the
reader's time on a map the change is not on, and a repository curating several would pay that cost
on every review.

There are **three answers here, not two**, and the header carries the denominator to tell the two
empty ones apart: `spines touched N of M`. `M == 0` says this repository curates no spine, so nothing
here is claimed either way. `N == 0` with `M > 0` says no spine claims a file or a flow this change
touches, which is a real reassurance and the first is not. `N > 0` is the answer this section is
mostly about. `--json` carries `spinesCurated` beside `spines` for the same reason, so a caller
reading an empty list can tell which empty it is.

## Proposing a spine at init

`empo init` cannot write the invariants (those require understanding the domain), but it can
propose the **skeleton** by scanning for critical-chain signals, then hand it to a human:

- **Tombstone commands.** Repair/regeneration scripts (`fix-duplicate-invoices`,
  `regenerate-ledger`) are grave markers for production incidents. A cluster of them over one module
  is a strong signal that module is a spine. Nobody writes a repair script speculatively.
- **Value columns.** Schema columns of a money/decimal type point at the data the chain moves.
- **Idempotency machinery.** Unique constraints, processed flags, and locks cluster where
  duplication would be catastrophic, i.e. along a spine.
- **An existing integrity check.** A scheduled job that recomputes and compares totals is the
  invariant list, already written and executable. Cite it directly.

Only the first of those four is a signal the graph can hint at, and init's brief prints what it found
(a node whose name or file name carries a repair verb) marked as candidates to confirm by reading,
never as conclusions: whether a script repairs data or merely seeds it is in its body. The other
three live in schema definitions, migrations and job bodies that no pack indexes, so the shipped map
discipline sends the agent to read for them rather than pretending the graph saw them.

The proposal comes back as a draft `spines/<name>.json` for the human to fill in and approve. The
hops and traps an agent can draft from the code; the invariants and the "which of these is
assertable at write time" judgement need a human who knows the domain.

### What the gate does with it

The agent writes one strict JSON proposal holding whole spine files, and
`empo init --proposal <path>` judges it before anything is written ([06-cli](06-cli.md)):

- Every citation is resolved by the same checker `empo verify` runs. An anchor that moved corrects
  the line to where the anchor really is, because a coordinate four lines off is a stale number and
  not a fiction.
- **A single citation whose anchor is nowhere drops the whole spine**, named in the verdict, and not
  merely the hop that carried it. The severity is deliberate and it is the asymmetry with a review's
  findings gate, which drops only the finding that failed. A findings list is read one finding at a
  time. A spine is read as a map, by somebody locating themselves before touching a chain where
  mistakes are expensive, so one invented coordinate turns every other coordinate in the file into a
  question, and a map that must be re-verified before use is worth less than no map.
- A spine whose file already exists is never overwritten, and a `name` that would write anywhere
  other than the spines directory is refused. A curated spine is the one artifact here that nothing
  can regenerate.
- The corrected skeleton is re-validated against the schema above before it is offered, because what
  a generator hands a human to approve has to satisfy the validator that will refuse it at load.

`empo init --proposal <path> --apply` writes what survived, on the human's say-so and not the
agent's. From that moment the file is human-owned and appended in place, exactly like one written by
hand.

## Feeding learning back (why the spine compounds)

When a review or a change surfaces something the spine does not know (a new trap, a flow that
duplicates the logic, a test that turns out to assert nothing, a moved line), the change updates the
spine in the same session, adding a citation with a distinctive anchor so `empo verify` can watch it
later. A finding left only in a chat message is a finding the team pays to rediscover. The spine is
the one artifact here that compounds, and keeping it current is not optional housekeeping, it is the
reason the spine stays worth having.

That loop now starts in the brief. "What a review reads in a spine" above is where the reviewer is
shown the chain, the invariants and the traps before reading the diff, so what the spine is missing
is visible at the moment the code that contradicts it is being read, rather than remembered
afterwards. A `PROSE ONLY` invariant the change could have asserted, an `UNGUARDED` flow the change
gives a test, a hop the brief printed as drifted: each of those is a spine edit the same session can
make, and the brief is what named it.

## Generality beyond money

The schema is domain-neutral. An **auth** spine's hops are guard -> policy -> scope -> query; its
invariant is "no query crosses a tenant boundary"; its assertion term is a test that asserts a
forbidden fetch returns empty. A **data-retention** spine's hops are the deletion cascade; its
invariant is "a deleted user leaves no residual rows." The mechanism (hops, guarded globs, invariants
with executable citations, drift-checked anchors, a write-time-assertion preference) is the same. Only
the content differs, and the content is the target team's.
