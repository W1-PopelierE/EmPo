# 06. CLI

The CLI is layer 1: deterministic, no LLM, no network for the core commands. The binary is `empo`.
The governing rule for the whole surface: **every command must be useful to a human in a terminal
with no agent attached.** If a command only makes sense when an agent drives it, it is a prompt
wearing a CLI's clothes and does not belong here.

There is one deliberate exception, `empo hook <event>`, which answers a host and not a person. It
earns the exception by adding no rule of its own: every gate it fires is a mechanical command a human
can run in the same terminal, and if the hook never existed nothing would be unavailable.

There is a second exception, on the other axis. **`empo upgrade` reaches the network, and it is the
only command here that does.** Nothing that reads a codebase makes a request, so the rule that
matters is not "EmPo never touches the network" but the narrower and more useful one: **no command
that analyses your code makes a request, and the one that does runs only because a human typed it.**
There is no background update check, no version ping on startup, and no telemetry, and there must
never be one. A tool that phones home while it is reading somebody's private codebase is a different
tool, and adding the call quietly later would be the way that happens.

## Command summary

| Command | One line | Needs LLM? | Needs network? |
|---------|----------|-----------|----------------|
| `empo init` | Detect languages, scaffold `.empo/`, wire host, propose flows/spines | yes (proposal step) | no |
| `empo index` | (Re)build `generated/graph.json` from source | no | no |
| `empo query <symbol>` | Blast radius: what breaks if I change this, and would a test notice | no | no |
| `empo verify` | Resolve every spine citation, report drift | no | no |
| `empo check` | Commit gate: spine touched without a value-asserting test? | no | no |
| `empo review [<pr>]` | Run the review discipline over a PR or local diff | yes | only via `gh`; an `mcp` forge makes none |
| `empo update` | Regenerate the host wiring, `AGENTS.md`, `.claude/` and `.codex/`, from this config | no | no |
| `empo upgrade` | Replace this standalone binary with the latest GitHub Release | no | **yes**, and it is the only one |
| `empo doctor` | Health: staleness, config validity, unmapped dirs, bridge match rates, unclaimed files, wired hooks that do not run, `commit` vs git | no | no |
| `empo hook <event>` | Answer one host hook: payload on stdin, JSON on stdout, silence when all is well | no | no |
| `empo pack test <name>` | Run a language pack against its fixtures | no | no |

`init`, `review` are agent-assisted. Everything else is pure mechanism. The agent-assisted ones
are thin: they orchestrate, but the facts they stand on come from the mechanical commands.

## `empo init`

Scaffolds a project, and prompts for nothing. A command that asks questions cannot run in a hook, in
CI, or under an agent, which is exactly where a scaffolding command earns its keep, and the two
questions it would have asked are two flags with a defensible default that a human can change
afterwards in a file they own. Steps, in order:

1. **Detect languages.** Walk the repo, match files against every installed pack's `match`: a
   manifest basename says a package is rooted here, extensions say which files are whose. Report the
   detected roots, their language and their file counts. Every candidate it discards is printed with
   the reason, because the surprising results (a workspaces manifest that roots nothing because every
   file under it belongs to a deeper root, two languages sharing one directory) are the ones a human
   has to understand before accepting the config.
2. **Scaffold `.empo/`.** Write `config.json` (roots, packs, `ignore`, an empty `bridges`), an empty
   `flows.json`, an empty `spines/`, a `conventions.md` explaining itself, and the `.gitignore`. No
   `framework`: it is not detectable from a pack's `match`, so it stays a human field
   ([03-config-schema](03-config-schema.md)). Each root's **`aliases`** are written, read out of the
   toolchain config the root's pack names in `aliasSources`
   ([04-language-packs](04-language-packs.md)), because an alias map that nobody seeds and nobody
   writes by hand is not a narrower graph but a missing edge for every aliased import in the
   repository. The **forge** is written, from the `origin` remote,
   because the pull request host is already on disk and a command that asks for what it can read is a
   worse command; GitHub becomes `github` and every other host becomes `mcp` with `host` naming it.
   It reads the url as configured and not as `git remote get-url` expands it, so an `insteadOf`
   rewrite pointing github.com at a local proxy does not turn a GitHub repository into an
   unrecognized host.
   The **tracker** is not, because nothing in a checkout says where the tickets live, and init says
   so out loud rather than leaving it implicit: until one is configured, every review skips
   ticket-fit and grades a change against no acceptance criteria at all. `--tracker jira` seeds one.
   For a repository with two or more languages and no bridge, init prints that cross-language reach
   reads as zero until a human configures one, because that answer is indistinguishable from the one
   a repository with no coupling at all would get.
3. **Wire the hosts.** Three targets: the managed block in `AGENTS.md`, the standalone `.claude/`
   configuration, and `.codex/skills/`. Both host directories receive the three generated `empo-*`
   skills; Claude alone receives EmPo's hook entries merged into `settings.json` (see
   [10-distribution](10-distribution.md)). `--no-host` skips all three and touches nothing outside
   `.empo/`. Init prints that Claude's hooks need `empo` on PATH and fail open without it, so nobody
   counts on a gate that is not firing.
4. **Build the first graph.** Run `empo index` so the proposal step has real data.
5. **Propose flows and spines (agent step).** Two phases, below.

**Init never overwrites what a human owns.** Every file the scaffold in step 2 would write and finds
already present is reported `kept` and left byte for byte as it was. That is what makes it safe to
rerun, and it doubles as the repair command for a half-scaffolded repository. There is deliberately
no `--force`: a tuned config, approved flows and a false-positive register that grew over months of
reviews are not reproducible from a file listing.

**The host wiring in step 3 is the exception, and it has to be, because none of it is human-owned.**
The six skill files are generated whole out of the config, so a run rewrites one that is already
there and each file says so in a comment at its top. That is the point rather than a cost: a skill
kept as it was found would go on describing the roots and packs of a config that has since changed.
Claude's `settings.json` and the managed block in `AGENTS.md` are merged rather than replaced, so
what a team wrote around EmPo's own entries survives ([10-distribution](10-distribution.md)). Every
host artifact reports `created`, `updated` or `unchanged`, never `kept`, and `unchanged` is decided
on the content, so a rerun with nothing to change still leaves a clean checkout clean. `--no-host`
skips the whole step.

**An `aliases` section prints between the scaffold and the forge**, and only where some pack in play
declares an `aliasSources` block: a repository written in a language whose imports carry no aliases
is told nothing rather than told that nothing was found. Where it prints, each root gets a line
saying what its toolchain says, in one of three states, and the states are worth telling apart:

- `resources/js    3 aliases from tsconfig.json`, then one indented `pattern -> targets` line each.
  That is the seeded map, printed whole rather than counted, because the whole of it is what a human
  is being asked to keep.
- `apps/api        no aliases in tsconfig.json`. The file is there and declares no map, which is the
  one state where a reader might reasonably have expected aliases and there genuinely are none.
- `packages/ui     no toolchain config under it, so no aliases`. A normal root, and a different fact
  from the line above it.

Under each root come the gaps, in the seeder's own words: an `extends` naming a package rather than a
path, which it will not follow because a package resolves through a module resolver this command does
not run; an `extends` naming a file that is not on disk; a file that would not parse; a `paths` field
that is not a map; a target that resolves outside the repository, dropped and named; and a chain
deeper than the eight files it follows. Each of those is a pattern the build has and the config does
not, so it is printed rather than dropped: a silently narrower map does not narrow an answer, it
deletes edges. Where anything at all was seeded the section closes by saying that the map is a copy
taken once, so a later edit to the toolchain config does not reach it.

**The alarm is separate from the outcome, and it fires only on a real disagreement.** On a rerun
against a repository that already has a config, init writes nothing, so the seeded map above is what
the toolchain says and not what the graph will use. Where the two agree that is uninteresting and
nothing is said about it. Where the config is missing a pattern the toolchain declares, or gives it
different targets, the section opens with `NOT written`, states the consequence in one line (every
import written through those patterns is an edge the graph does not hold) and says to copy what is
right into `roots[].aliases` by hand. That is the rule the forge block already follows: the
outcome first, and an alarm only where the config and the world actually disagree, because an alarm
that is usually false is one nobody reads on the day it is true. Targets are compared as ordered
lists rather than as sets, since the first target that names a node wins and a reordered list is a
different map.

Flags: `--repo <path>`, `--lang php,typescript` to force the packs instead of detecting them,
`--tracker <host>` to seed `{ "kind": "mcp", "host": "<host>" }` as the tracker (there is no
`--forge`, because that one is read from the `origin` remote), `--no-host` to touch nothing outside
`.empo/`, `--config-at-root` to write `empo.config.json` at the repository root instead of
`.empo/config.json`, `--commit-generated` to keep `generated/` in version control, and
`--proposal <path>` with `--apply` for phase 2.

There is no `--yes`. An earlier version of this doc listed one for accepting the detected roots
without prompts; there are no prompts, so the flag would do nothing, and a flag that does nothing
teaches a false model of how the command works. If detection disagrees with the repository, the
repair is to edit the config it wrote, or to rerun with `--lang`.

There is no `--json` either. The brief is prose for an agent to read, and init's machine-readable
surface is the proposal file plus the exit code.

### Step 5 runs in two phases

Exactly like `empo review`, and for the same reason: the CLI makes no model call anywhere, so the
agent that does the mapping sits between the two halves.

**Phase 1, the brief.** `empo init` prints the facts, all of them drawn from the graph it has just
built rather than from a directory listing: the structure by directory, the kinds the packs tagged,
the entrypoints nothing in the graph references (so a journey starts there), the produced route
symbols, the widest fan-in, the repair-verb candidates that hint at a spine
([08-spines](08-spines.md)), and the flows and spines already defined, so nothing proposes them
twice. Every list is capped, and a capped list says how much it left out, because a silent cap reads
as "all of it".

The entrypoints list is the one that reads the packs rather than only the graph, and it uses **both**
kind axes ([04-language-packs](04-language-packs.md)). A kind marked `arrivedBy` is ranked first, so
the cap can never hide a route file behind a directory of views: measured over a Laravel application
the section held 285 rows, 278 of them framework-resolved, and the five route files sat at
positions 280 to 284 and never printed under a heading that says a journey starts here. A kind marked
`resolvedBy` that no one arrives at is dropped, counted and named in a line under the section, never
dropped quietly. A kind carrying neither mark is unclaimed rather than denied and prints as it always
did. This is deliberately not `--orphans`' filter, which would take the route files with the
migrations: the two commands ask different questions of one set, "is this dead?" against "does a
journey start here?", and a route file answers no to the first and yes to the second.

The brief then prints the shipped map discipline (`src/discipline/map.md`, loaded the same
way `empo review` loads its own) and names the proposal file to write. That file lives in the OS
temp directory and never under `.empo/`, the rule a review's scratch already follows: `.empo/` holds
what a human approved, and a proposal is a draft passing between two processes.

**Phase 2, the gate.** The agent writes the proposal and runs `empo init --proposal <path>`, which
gates it against the graph and the real source and prints a verdict. Adding `--apply` writes only the
survivors. **Nothing an agent proposes reaches `.empo/` until a human runs that second command**,
which is what "never as fait accompli" means in practice. What lands is a starting point: the human
renames, merges and prunes it.

The gate's rules are mechanical, and worth stating exactly, because an agent that can predict them
writes a better proposal:

- A proposed flow path that matches no node in the graph is dropped, and the verdict names which of
  three it was. A path that is not on disk at all is an invented directory. A path whose every node
  in the graph is a test owns nothing, because no test node is ever assigned to a flow
  ([05-graph-model](05-graph-model.md)), so that path named a suite rather than the code of a
  journey. A path that is on disk and holds no node at all means a stale graph or a tree under no
  configured root, which the human repairs rather than deleting a true path over it.
- A flow left with no surviving path is dropped whole, so padding a flow with paths that might exist
  costs the flow.
- A flow name `flows.json` already defines is reported as a change for the human to make and is never
  merged. That file is theirs.
- A spine citation whose anchor moved is corrected to the line the anchor is really on, by the same
  resolver `empo verify` uses. **A single citation whose anchor is nowhere drops the entire spine**,
  named in the verdict, because a map with one invented coordinate turns every other coordinate in it
  into a question ([08-spines](08-spines.md)).
- A spine whose file already exists is never overwritten, and neither is a `flows.json` entry.

The gate exits 0 whatever it drops, because a proposal is a suggestion and only `check`, `verify`,
`index --check` and `pack test` return 1. What a dropped proposal costs is the agent's next attempt,
not somebody's commit. A proposal file that is missing, is not JSON, or breaks the schema is a config
error and exits 2 like any other.

The proposal file is strict JSON: `version: 1`, `flows` keyed by flow name, and `spines` as an array
of whole spine files, both defaulting to empty because proposing nothing is a legitimate answer. It
is validated by `src/schema/proposal.schema.ts`, which imports the flow and spine schemas rather than
restating them, so a proposal cannot pass the gate and then fail at load. An unrecognized key is
refused with the key named: a misspelled `assertionTerm` silently dropped becomes a spine with no
assertion terms, and the human approving the diff has no way to see what went missing.

## `empo index`

Rebuilds the graph. Deterministic, seconds, no network. Prints node/edge/join counts and the sha
it built against, and a match rate per join, which covers the bridges config declares and the joins
a pack declares over its own symbols alike. Run it whenever the codebase moved. Flags: `--repo <path>`, and `--check` to exit
non-zero if the graph would change (a CI staleness gate).

**A names block prints between the flows line and the built line**, one line per edge family whose
rules resolve a bare name. On this repository's fixture:

```text
names      hook     2 of 2 resolved
names      template 1 of 1 resolved
```

It is the yield of the `short-name`, `observer` and `view` strategies
([04-language-packs](04-language-packs.md)): how many of the names those rules read became an edge,
out of how many they read. It sits beside the counts rather than among the warnings below because a
family that refuses is not a defect the way a duplicated node id is — a vendor component resolving to
nothing is the strategy working — and what a reader needs is the ratio on every run, so the run where
it collapses reads as a change rather than as the first time anybody looked. `empo doctor` prints the
same block off the same graph, and the refusal clauses, `short-name`'s two-pass lookup, the two
sentences that replace the numbers, and why the block raises no finding are all set out there.
`empo query` prints it too, beside the answer, but only the families that read a name there.

**Not built yet: `--root <path>` to reindex one root.** A partial rebuild is only safe while no edge
crosses a root, and bridges made that untrue: a bridge edge has one end in each root, so rebuilding
one root alone would drop or invent cross-language edges and would have to merge into an existing
graph rather than replace it. A full rebuild is fast enough that nothing has needed it yet
([14-implementation-notes](14-implementation-notes.md)).

## `empo query <symbol>`

The core question. Accepts a node id, a repo-relative file path, a path suffix or a short name, tried
in that order:

```bash
empo query apps/api/app/Libraries/Price/PriceCalculator.php
empo query PriceCalculator          # short name resolves if unambiguous
empo query Order
empo query apps/mobile/src/api/client.ts#createOrder   # one export, under a symbol pack
empo query apps/mobile/src/api/client.ts               # every export that file holds, unioned
```

**A path answers for every node the file holds, and that is not a convenience.** Under `fqcn` and
`module-path` a path names one node and the question does not arise. Under `symbol` a file holding
four exports holds four nodes, so refusing the path as ambiguous would refuse nearly every path a
reader can type at a TypeScript repository, and it would do so while saying the answer is
unknowable, when the answer is simply the union over that file's exports. The radius is unioned
before it is counted, so a consumer that imports two exports of the file is one consumer and one row
rather than two.

What is genuinely ambiguous is unchanged and still refused: candidates spanning more than one file.
There the reader asked about one thing and the graph holds two, and picking either would be this
command guessing which file was meant. The refusal lists the candidates with their files so the next
command can be the full id or the full path.

Output (human-readable, and `--json` for machines):

- **fan-in**: how many nodes import/reference this one, counted once per node however many rule
  families found it ([05-graph-model](05-graph-model.md)), which is why a file that imports a
  component and then renders it is one consumer and one row. A node is what the asked-about pack
  ids, so under `symbol` the unit being counted is the export: one file whose two exports each
  reference the target is two consumers, because two things in it would have to be read before the
  change is safe, and the rows name which two.
- **flows reached**: every flow this change can reach, across roots, not just the obvious one.
- **blind flows**: the flows that reach this code but have no value-asserting test, printed in
  capitals, because a wrong result ships silently there.
- **the reaching tests, counted in files**: the `N tests reach it` beside a flow and the
  `reached by` lines under `--blind` are both read from `coverage[].testFiles` and never from
  `testNodes`, which is the same unit `empo review` prints and the one
  [05-graph-model](05-graph-model.md) fixes for every surface that says "N tests". It only ever
  mattered under `symbol`: a test file exporting three cases is three test nodes and one file, so
  counting nodes reports one reaching test as three and inflates the apparent coverage of exactly
  the flows this command exists to be honest about. Under `fqcn` and `module-path` the two lists are
  the same reach in two units, which is why the wrong one read as correct for as long as no pack
  ided by symbol.
- **top consumers**: the highest-fan-in nodes that depend on this one, each row naming the
  consumer's own kind and the edge family the reference was written in. The two columns are what
  make the list readable once a template can be a sink: a changed Laravel layout is consumed both by
  the controller that renders it and by the sibling blades that `@extends` it, the rows are ranked
  by the consumer's own fan-in, and the sibling templates are themselves extended — so they can fill
  the printed rows while the controller falls into the "and N more" below, and printed as bare ids
  the two are the same shape. The **order is deliberately untouched**: a consumer that is itself
  widely used is genuinely the one to read first, and the count saying so is in the same row. What
  was missing was never the ranking, it was what each row is. The family is `template`, `import`,
  `fqcn`, `hook` or `string`, and never the directive: a graph records which rule family matched,
  not whether the php that matched wrote `@extends` or `view(`.
- **symbol joins**: any bridge edge, e.g. "a mobile screen calls a route this file
  defines," so a backend change's mobile blast radius is visible. **The heading says "symbol joins"
  and no longer "cross-language reach"**, because a pack can declare a join over its own symbols
  inside one root ([04-language-packs](04-language-packs.md)): the php pack joins
  `scheduled-command`, so a Laravel scheduler entry and the command class it names are two ends of
  one bridge edge and both of them are php. A heading promising two languages would be a false fact
  printed above true ones. **Both ends of the join are printed**, the consuming side and the
  producing side, because either one can be the file you asked about: a join edge runs from the
  caller to the definer, so naming one end alone answers the question from one direction and repeats
  it back from the other. Where no join edge is in the radius, the line says which of the two
  silences it is in, a graph holding no join edges at all or joins that are simply nowhere near this
  node.
- **names block**: what the name-resolving rules yielded on this repository, in the same lines
  `empo index` and `empo doctor` print and `empo doctor` documents below.
- **staleness line**: `built_against` sha and commits-behind-HEAD.

The names block prints after the answer body and before the staleness lines, under every mode and
not only the blast radius, because every mode is built out of the same edges. It is not in `--json`:
the machine form is the answer object and its caveat, and the yield is a fact about the graph the
agent can read out of `empo doctor --json`, where it already rides.

**It prints only the families that actually read a name here, and nothing at all otherwise.** That is
a deliberate difference from `empo index` and `empo doctor`, which print the block unconditionally
and have two sentences for the two silences — nobody counted, and counted but nothing read a name.
Both of those are answers about the graph rather than about the node you asked about, and both
surfaces already say them; what belongs beside an answer is the case a reader of that answer can be
misled by, which is rules that read names here and resolved few of them. So a family with a name
count of zero contributes no line, and a query on a repository where nothing resolves by name is as
quiet as it was before.

The motivating measurement is the reason it prints at all. On a real 186-file React Native
application the `template` family resolved 3 of 1531 tag references, and `empo query` said nothing
about it: every blast radius it printed was missing nearly every component edge, and read exactly
like a blast radius that was complete. A radius whose component edges nearly all failed to resolve
is not wrong, it is thin — the caveat at the foot of every answer already says the radius is a floor
— and thin is indistinguishable from complete unless the yield prints where the answer does.

Modes:

```bash
empo query --gods          # the 20 widest-blast-radius nodes and their kinds, and a count of the rest
empo query --blind         # flows where no test asserts on a produced value
empo query --orphans       # code with zero consumers, minus what a framework resolves by name
empo query --orphans --all # ... and the framework-resolved ones too
empo query --hazards       # jobs queued inside a database transaction, before it commits
```

`--gods` names each row's kind, and it exists because the ranking is right and was unreadable
without it. Once the `view` strategy made a template a sink, the widest fan-in in a php repository is
often a Laravel layout, and it deserves to be: a change to the file every page `@extends` really does
reach every page. What a reader could not do was tell that from a list printing a count, an id and a
path. Neither of the two alternatives was taken: holding framework-resolved kinds back would hide the
very fact the list exists to show, and capping the rows one kind may take would make the top 20
something other than the widest 20. The path is dropped from a row whose id already spells its path,
which is every node a pack ids by path and every node a `symbol` pack ids by an export, since
`src/money.ts#formatMoney` carries the path in front of the `#` and the export name is the only part
of the row a reader did not already have. The `--json` form keeps both fields either way, since an
agent reading it should not have to know which strategy ided the node.

`--blind` carries its denominator as `flowsConsidered` in the JSON, always: how many flows the graph
holds, how many of them a test reaches at all, and how many have a reaching test that asserts a
value. An empty list is three different results wearing one shape, and only one of them is the good
news a reader assumes. A flow no test reaches can never be blind however untested it is, and a graph
holding no flow has nothing that could be, so both of those answer `[]` for reasons that are worse
than the answer looks. Each gets a sentence of its own, carried as `flowsConsidered.reason` and null
where the list can be read as it stands, which is the same rule `--hazards` follows for a graph too
old to hold the record.

The printed form states the counts under every answer **holding a flow**, empty list or not, since
three blind flows out of four and three out of ninety are different facts and a line that appeared
only in the good case is one nobody would learn to look for. The one answer with no count sentence
is the graph holding no flow at all, where `of 0 flows, 0 are reached` would state nothing twice and
the reason line carries the whole answer instead.

`--orphans` is fan-in zero, minus every kind its pack marks `resolvedBy: "framework"`
([04-language-packs](04-language-packs.md)). A blade view is rendered by name, a migration is
discovered by the runner, a policy is found by its class name: the framework is the caller and no
rule here can see the call, so a fan-in of zero is not evidence about them either way. The mark says
who resolves the kind, not that an instance can never gain an edge — the php `view` rules do read
`view('orders.show')` and `@extends`, so the blade file they name leaves this list through the
fan-in test rather than through the filter, while the one rendered by `view($name)`, a view composer
or a computed `@include` looks exactly like a view nobody renders at all and is still held back.

**What a row is depends on the pack, and under `symbol` a row is an unused export rather than a dead
file.** A live `src/money.ts` whose `formatMoney` everything imports and whose `parseMoney` nothing
does yields one orphan row, for `parseMoney`, and no row for the file. That is the more useful of the
two answers and the more easily misread one: nothing on the row says the file is dead, because the
file is not, and an agent that deletes a file off an orphan row is now deleting live code rather than
merely unused code. So the unit is stated on the answer rather than left to be inferred from the
shape of an id: the
heading reads `orphans: nothing in the graph references these exports` there and `… references
these` everywhere else.

**The unit is named only where the whole graph agrees on one**, which is a third case and not a
rounding of the first two. The heading says `these exports` where **every** node in the graph carries
a symbol, and not where merely some do, because a monorepo holding a php root beside a TypeScript one
yields a list whose rows are class names, route files and exports together, and one word cannot be
true of all three. So `fixtures/acme-platform` prints the unit-neutral heading even though
`apps/mobile/src/api/client.ts#fetchLoyaltyPoints` sits on it beside
`Acme\Http\Controllers\AdminController`: the ids on the rows still say which each one is, and the
heading declines to say it for them. The rule is the one every heading in this tool follows, that a
summary line may not claim more than the answer under it supports.

The same two fallbacks that widen an import edge widen this list's silence in
the safe direction: an
export reached only through a side-effect, dynamic or default import is credited with the fan-in of
the whole module and so never appears here, which is a floor on what the list claims is unused.
Measured over a Laravel application the unfiltered rule returned a few hundred candidates and almost
none of them were dead code: blade views and migrations dominated the list, then the config and
bootstrap files the framework loads by path, then the policies, factories, seeders and console
commands. An agent handed that list proposes deleting `UserPolicy`, which is precisely the false
answer this tool exists to prevent, so the filter is load-bearing rather than cosmetic.

**What it leaves out, it names.** The answer states how many nodes were excluded and under which
kinds, why a fan-in of zero is not evidence that they are dead, and the command that lists them
anyway. A filtered list that says nothing about its filter reads as the whole list, which is the
same defect one level up. `--all` prints them alongside the real orphans, each marked with what
resolves it, so nobody scanning for something to delete has to remember a header. Under `--json`
those facts ride in a `frameworkResolved` object (`listed`, `total`, `byKind`, `reason`,
`listWith`) and each row carries its own `resolvedBy`, because the agent reading the machine form
never sees the printed line and is the reader who would act on it.

`--all` with any other mode is a config error rather than a no-op. `--orphans` is the one mode that
holds rows back, and a flag that quietly does nothing elsewhere teaches a reader that some other mode
was filtering too.

`--hazards` lists every queued job dispatched from inside a database transaction that does not wait
for the commit. The queue does not roll back with the database, so a worker can pick such a job up
and run it before the rows it needs exist: the code reads correctly, the test passes, and the failure
arrives under load on somebody else's machine. It generalizes a check that caught this class of bug
repeatedly, and it is the one mode here that finds a defect rather than sharpening an answer the
graph already gives.

Each hazard prints as two lines. The first names the job as it is written at the dispatch site, the
line the enclosing transaction opened on, and the dispatch's own `file:line`; the second says what
the job resolves to in the graph. A dispatch whose job is named through a variable or handed over by
a factory resolves to nothing, and the answer says so rather than dropping the row, because what
makes it a hazard is the enclosure and not the callee. When transactions nest, the line reported is
the innermost one, which is the transaction a reader has to move the dispatch out of.

A dispatch that says it waits for the commit is not listed at all, whether it says so at the call
site or in the dispatched job's own declaration ([04-language-packs](04-language-packs.md) section 7).
That is the difference between a list of defects and a list of dispatches, and only the first is
worth a reader's time.

**It distinguishes finding none from nobody looking, and that distinction is the mode.** The
`hazards` block in a language pack is optional ([04-language-packs](04-language-packs.md)), so an
empty answer has three meanings and the command keeps them apart. Where the packs in play scanned,
the answer names them and reports that they found none. Where none of them scanned, it says that no
pack looked and that this is not the same as finding none. Where the graph itself predates the axis
and holds no such key, the answer is unknown rather than either of the other two, and names
`empo index` as the repair, because defaulting a missing field to an empty list is how a clean bill
of health gets invented out of something nobody ever wrote. In a monorepo it is usually a mixture, so
every language in play is named in one of two lists, and the ones that scanned for nothing are
reported with what their silence costs: a pack with no hazard rules examined nothing, so an empty
list over the files under its roots is not a finding. Under `--json` all of it rides in a `declared`
object (`looking`, `silent`, `reason`) beside `rows`, which is `null` rather than `[]` in the unknown
case, because the agent reading the machine form never sees the printed line and is the reader who
would take "none" for "clean".

**Which languages scanned is read out of the graph, not off the packs on disk**, so `--hazards` is a
pure function of the graph and needs no pack installed at all. That is the one place this mode
deliberately parts company with `--orphans`, which does re-read `resolvedBy` from the pack and does
need it present, and the asymmetry is the point rather than an inconsistency. `resolvedBy`
reclassifies nodes the graph already holds, so the data is there whichever way it is read, while a
hazard is found at index time and stored: a pack that grew its rules after this graph was built
scanned nothing, and asking that pack now would pair "this language looks for hazards" with an empty
list to state a clean result no run ever produced. The cost is that a graph older than the pack
reports that nothing scanned, which is true of that build, and `empo index` is the repair the
staleness line under every answer already names.

**What it cannot see, it cannot see by construction.** Detection is regex plus delimiter-walking, not
parsing, so enclosure is **lexical**: a dispatch counts when it is written between the two
coordinates of a transaction in one file. A dispatch reached through a helper the transaction calls
is invisible, however certain it is at runtime, and so is a transaction opened in a parent class or a
middleware. Hazard rules always read string contents as written: an `edges` rule can ask for them to
be blanked and a hazard rule has no such switch ([04-language-packs](04-language-packs.md) section
3), so a transaction opener written inside a quoted string opens an extent that no database opened,
and the dispatches it appears to enclose are reported. Both blind spots are set out with their
measurable direction in [04-language-packs](04-language-packs.md) section 7. Read the list the way
every other answer here asks to be read: a floor, not a ceiling.

## `empo verify`

Resolves every citation anchor in every spine against the current source and reports drift: a
`file:line` that no longer contains its anchor text, an invariant whose referenced check moved, a
trap whose line rotted. Both soft drift (the anchor is still in the file, on another line) and hard
drift (the anchor is nowhere, the file is unreadable, the path escapes the repo) exit 1, because a
coordinate that is quietly a few lines wrong misleads a reader as surely as one that points nowhere.
They are printed apart because the repair differs: a soft one prints the line to set, so the fix is
one number. This is what stops a hand-curated spine from quietly becoming fiction. Flags:
`--repo <path>`, `--json`. See [08-spines](08-spines.md) for the citation format.

## `empo check`

The commit gate. Its subject is the staged diff by default, which is what a pre-commit hook has;
`--base <ref>` is the CI form, judging every change against a branch, tag or sha. If the subject
touches a spine's guarded files and adds no test line that uses that spine's assertion terms, it
fails with an explanation naming the spine, the guarded files that changed, and the terms it looked
for. It can be bypassed only explicitly, never by unstaging the spine file to dodge the gate: the
spines are read from disk and the diff is only ever the subject. See [08-spines](08-spines.md) for
exactly what counts as an assertion, and [10-distribution](10-distribution.md) for the hook wiring.

**A spine can name the test files that speak for it**, in `assertionPaths`, and then only a line
added in one of those counts. Without it the gate is satisfied by an assertion added to any test
file in the diff, which is a real hole and not a theoretical one: a commit that changes the rounding
of a guarded money function passes on an added assertion in a theme test that imports nothing from
pricing. The two scopes intersect rather than replace, so declaring paths
can only narrow a gate and never widen it. `empo check` prints a second caveat on any answer holding
a spine that declares none, saying that the line may sit in a test with nothing to do with the
guarded file, and drops that sentence once every spine in the answer is scoped. Under `--json` each
spine carries `pathsWanted` beside `termsWanted`, and `caveat` is the same text the prose printed.

**A rename is judged on both of its paths**, because only one of them can be the guarded one. A
change that moves a guarded file out of its guarded tree is gated exactly as an edit in place is,
and the file is named by the spelling the spine claims with the destination printed beside it
(`src/pricing/money.ts -> src/util/money.ts  (moved out of the guarded tree)`), since the guarded
name is a path the file no longer has. Under `--json` each entry of a spine's `touched` is an object
carrying that pair, `path` and `movedTo`, and `movedTo` is null for everything that did not move.
See [08-spines](08-spines.md) for the other two directions a rename can go.

Flags: `--repo <path>`, `--base <ref>`, `--bypass "<reason>"`, `--json`. The bypass is how a human
states the change genuinely cannot affect a value, and it takes a reason rather than being a bare
flag, so the override is on the record instead of in someone's memory. Under `--json` that reason is
a field of the document rather than a line printed beside it, and `passed` keeps reporting the
mechanical verdict, so an override is visible to whatever reads the answer instead of looking like a
gate that quietly held.

## `empo review [<pr>]`

The agent-assisted review, and the one command that runs in two phases, because the CLI itself
makes no model call: the agent that works the discipline sits between them. On an `mcp` forge there
is a third phase in front of these two, for the same reason turned the other way: the CLI cannot
fetch the pull request either. That is a section of its own below.

**Phase 1, the brief.** `empo review [<pr>]` gets the PR through the forge adapter, finds the
tracker ticket via `keyPattern`, checks the source branch out into a detached worktree, and prints
the facts: PR metadata, the ticket with its acceptance criteria, the CI result, existing comments,
every changed file with its blast radius, the flows touched with the blind ones and the ones no test
reaches counted apart (a flow nothing reaches is not a covered flow, and treating it as one made the
brief print "every touched flow has at least one test that asserts a value" three lines under its own
"no test reaches this flow at all"), the spines
the change is on and what each of them still claims, the tests that reach the changed code, and the
state of the false-positive register. It then prints the shipped discipline from
[07-review-discipline](07-review-discipline.md) and names the findings file to write. With no
argument the subject is the local working diff against the base branch, and there
is no worktree, because the working tree is the thing under review. A review with no pull request id
does not consult the configured forge at all, and prints a note naming the one it skipped: there is
no pull request for a forge to answer about, so spending the id on a lookup only produced a failure
against a pull request nobody had named.

**The brief also prints every dispatch a changed file makes from inside a loop**, under the heading
`dispatches inside a loop  (step 2: what this change can put on the queue)`, one row per site naming
the `file:line`, the job it dispatches and the line the loop opened on. Under each row, where the
resolver matched the job to a node, a `target` line names that node and its file, and an `also
reached from` line names every other consumer of the job that a scheduler entry reaches, cited on
that entry's own scheduled line. Both are lookups and neither is new evidence: the job's consumers
are ordinary edges and a scheduled command is joined to the entry that schedules it. What they add
is having the two in one place, because what a dispatch does with a failure is written in the
handler and never at the call site, and a queue that a nightly loop fills and a five-minute entry
refills is a loop no single one of those three facts states. Only scheduled consumers are listed: the
row's whole value is the cadence at the far end, so a controller dispatching the same job on a click
has nothing to say here. The sites come from the
`loops` rules a language pack declares beside its hazard markers
([04-language-packs](04-language-packs.md)) and ride on the graph as an axis of their own. **It is a
fact in the brief and never a finding**, and every non-empty list says so in a sentence underneath:
how often the loop runs is a property of the data and not of the source. A dispatch inside a loop is
how a batch is written, and it is wrong only when what the loop iterates is unbounded — EmPo cannot
know how many rows a query returns, a rule that guessed would fabricate, and the model reading the
diff is the one that can go and read the query. So the coordinate is stated at the moment the diff
is read, and the finding, if there is one, comes out through the same verification gate as every
other. On a graph built before the axis existed the section says exactly that and asks for `empo
index`, rather than printing an empty list a reader would take for a clean bill of health; under
`--json` the same list rides at the top level as `fanout`, and is null and not `[]` in that case,
for the reason `--hazards` and `spinesCurated` are.

**The spines section has three answers, not two.** It prints `spines touched  N of M`, and the
denominator is there because `N = 0` means two different things. `M = 0` says this repository curates
no spine, so nothing here is claimed either way; `N = 0` with `M > 0` says no spine claims a file or
a flow this change touches, which is a real reassurance the first case cannot give. Under `--json`
the same pair rides as `spinesCurated` beside `spines`, so the agent reading the machine form can
tell the two empties apart as well: this is the rule `--hazards` already keeps for a graph older than
the axis. A spine surfaces for three separate reasons and they are reported separately, because they
ask the reviewer for different work: a changed file a `guarded` glob claims, which is exactly what
`empo check` will gate on and is computed by the gate's own function so the two cannot disagree
about a renamed file; a changed file a hop or a trap cites; and a flow the blast radius reaches
that the spine lists. The review is wider than the gate on purpose. A gate has to fail somebody's
commit and may therefore only fail on a rule its author wrote down, while a review is read by a human
who can weigh a weaker signal, and `guarded` is curated to be gateable while a chain runs through
files nobody wants gated. None of this adds a flag, and a spine-derived finding is still `impact` or
`coverage`: the findings schema is unchanged.

**The brief prints one blast radius per changed file, whatever the pack's node-id strategy**, and
under `symbol` that is a deliberate collapse rather than an oversight. A changed 20-export module
holds twenty nodes, and printing twenty fan-in blocks for one line in a diff would bury the change
under its own file. So the file's nodes are resolved together, their radii unioned, and one block
printed. What the per-export ids buy back is the column beside the path, which names the exports the
file holds, capped at five with a `+N more` for the rest: the ids all begin with the path already
printed two columns to the left, so the export names are the only new information the line can
carry. Where the nodes carry no export name the column falls back to the ids, which under a `fqcn`
pack is usually the class name and is then the whole answer.

**Inside that block the join rows are labelled by the symbol they matched**, `join <symbol>
<from> consumes <to>  named at <file:line>`, and not by the word "cross-language" they used to
carry: a pack can join a symbol inside one root, so a scheduled command joined to the entry that
schedules it is php on both ends and calling the row cross-language tells a reviewer reading a php
diff that the php file is on the far side of a language boundary, which is not a fact about
anything. Both ends print for the reason `empo query` prints both, that the changed file is as often
the consuming side as the producing one.

**The nodes in that block are the exports the diff's lines touched, not every export the file
holds.** Each symbol node carries the lines it spans (`nodes[].extents`,
[05-graph-model](05-graph-model.md)) and the hunks say which lines moved, so editing one export of a
twenty-export module reports that one export's radius and the column reads
`1 of 20 exports: parseMoney`. The count is printed only where something was left out; a file whose
every node is in the block says nothing, because there is nothing to have missed. Under `--json` the
same pair rides as `files[].nodesInFile` beside `files[].nodes`.

**The narrowing is refused whole-file the moment a changed line cannot be attributed**, and that is
the load-bearing half of it. An extent is a line partition rather than a parse
([04-language-packs](04-language-packs.md)), so it can hand a helper written between two exports to
the export above it, and a review that names one export too many costs a reader a minute where one
that silently drops the export a change really touched is a blast radius that is wrong and reads as
right. Three cases fall back to every node of the file, which is the answer this printed before
narrowing existed: a changed line no extent encloses, which is every edit above the file's first
declaration and the import block at the top of a file is the ordinary one, while an import written
between two exports falls inside the extent of the one above it; a cut line lying past every extent,
which is what deleting the last export of a file looks like; and a file whose nodes carry no
`extents` at all, which is a `fqcn` or `module-path` pack, a `symbol` pack's file that exports
nothing, and every node of a graph written before schema 8. A removed line is read against the same
extents as an added one, by the coordinates it had in the old file, because a hunk that only deletes
writes no new line to attribute it by and answering a deletion with whatever survived around it
reports the radius of the code that did not change. Those coordinates are the old file's and the
extents are the indexed file's, so a graph that is behind the branch can attribute a cut to a
neighbouring export; that is staleness, it is reported as staleness at the top of the brief, and its
error is in the over-attributing direction.

**Usually, and not always.** A `fqcn` pack that declares `fallback: "path"` ids a file holding no
class by its path, so the id and the path are one string and the column repeats verbatim what is
already two columns to its left. `fixtures/acme-platform` has the case in
`apps/api/routes/api.php`, a route file the php pack names by its path because there is no class in
it to name. The line is not wrong, it is empty of new information, and that is the honest floor of a
column built out of ids: the fallback exists so those files get a node at all
([04-language-packs](04-language-packs.md)), and a node ided by its path has no shorter name to
print. Trimming the repeat would take the column deciding a row deserves nothing, which reads as a
file whose nodes it could not name.

The tests block names each reaching test **file** once, from `coverage[].testFiles` rather than from
`testNodes` ([05-graph-model](05-graph-model.md)). A test file exporting three cases is three nodes
and one file, and a reviewer told "3 tests reach this" would go looking for three files.

**The spines are read from your own checkout, and their coordinates are resolved against the code
under review**, which on a pull request are two different commits and deliberately so. The map is the
one the team curates; the code it is checked against is the code the change proposes. So a pull
request that moves a hop's anchor reports drift right there in the brief, which is the earliest
anyone can be told, and a change that edited the map and the chain together cannot report itself as
consistent. Drift is stated per coordinate rather than counted at the top, because the reader opens
these one at a time and a summary tells them the wrong thing about the one in their hand, and it
follows the same asymmetry as the findings gate: a moved anchor is printed at the line it is really
on, with the line the spine still claims beside it, and an anchor that is nowhere is printed as the
spine wrote it and labelled `ANCHOR NOWHERE`, naming `empo verify` as the repair. Only the touched
spines are verified, so a repository curating several does not spend the reader's time resolving
coordinates on a map this change is not on. See [08-spines](08-spines.md) for the citation format,
and [07-review-discipline](07-review-discipline.md) for what a reviewer does with the section.

**Phase 2, the gate.** The agent writes its suspected findings to that JSON file and runs
`empo review [<pr>] --findings <path>`. Every citation is resolved against the source phase 1 read,
at the read root its session recorded, every finding whose text hedges is linted out, only the
survivors are printed, and the worktree is removed. A finding whose anchor is not in the file it
cites never reaches the author, which is the whole product.

It never executes the target project's tests or static analysis (CI does that); coverage judgement
is a reading task.

### An `mcp` forge adds a phase in front of the brief

EmPo holds no token and makes no network call, so on a Bitbucket or GitLab repository it cannot fetch
the pull request and the agent running it can ([09-adapters](09-adapters.md)). So `empo review <pr>`
against an `mcp` forge, with no payload yet, prints a **request block** instead of a brief: the file
path to write, the exact JSON shape with every field named, what omitting each optional field means,
and the command to run next. When the tracker is also `mcp` it asks for the ticket in the same block,
conditionally, so the agent reads the title it just fetched and applies `keyPattern` itself. That
keeps one pull request to one round trip; asking separately would need three invocations, because the
ticket key is extracted from the pull request.

**The request block exits 0.** Nothing failed. It is the same two-phase handoff this command already
makes between the brief and the findings, and the exit table below has no code for "the next step is
yours" because 1, 2 and 3 all mean something went wrong.

The agent then reruns with `--pr-payload <file>`, and the review proceeds. Before any of it runs, the
payload is read, validated and checked against git: its id must be the id that was asked for, and
both branch names must resolve to real commits here. Anything that fails is **exit 2** with every
problem listed at once, so an agent that has to fetch again learns all of them on the first try. Exit
2 and not 3, because nothing about the environment is broken: the agent handed over a payload it can
fix.

The flag is `--pr-payload` and not `--pr` because the pull request id is already the positional
argument, and `empo review 412 --pr payload.json` would spend one word on two meanings in a single
line, in the one place whose reader is a machine copying literally.

Three more things about these flags. `--pr-payload` without a pull request id is a config error,
because without the id there is nothing to check the payload's own id against. Either flag against an
adapter that is not `mcp` is refused rather than ignored, because only an `mcp` adapter reads a
payload and silently accepting one would let somebody believe a review had used a file it never
opened. And a `--pr-payload` path that names no file is treated as "not fetched yet" rather than as a
bad flag, since a review takes its scratch directory down with it when it finishes: rerunning a
command that worked once finds its own payload gone, and the request block is the useful answer to
that, not a missing-file error.

The payload paths are derived from the review's session directory in the OS temp directory and are
**not configurable**, for the reason [09-adapters](09-adapters.md) gives: a payload carries ticket
bodies from private trackers, and a configurable path is one somebody eventually points inside the
repository they commit.

Under `--json` the block is not printed as prose. The command emits one document instead:
`awaiting`, `id`, `host`, `payloadPath`, `ticketPath` (null unless the tracker is also `mcp`),
`command`, and `instructions` carrying the block text, so a caller can act on the fields without
parsing sentences.

### A fetchable forge with an unfetchable tracker asks too, and asks better

The block above fires on the **forge**, so a `github` forge beside an `mcp` tracker printed nothing
and nobody was ever asked for the ticket: ticket-fit went ungraded on every review a team on GitHub
pull requests and Jira or Linear tickets ran. The report always said so, which is why this was a gap
and not a defect, but a stated blind spot nobody can fill is still a blind spot.

So there is a second request point, and it is a better ask than the first because it runs **after**
the fetch rather than before it. EmPo has the pull request in hand, applies `keyPattern` to the
title, the branch and the description itself, and asks for **one ticket by key**, where the block
above can only print the pattern and ask the agent to do the matching. It exits 0 on the same rule,
it prints before any worktree is created, and it fires only when every one of these holds: the
tracker is `mcp`, the forge is not (the block above already covers that case, and asking twice for
one round trip is worse than asking once), no `--ticket-payload` was supplied, `--no-ticket` was not
passed, and the pull request actually names a key. No key means nothing to name, and stopping there
would stop every review in every repository whose branches carry no ticket ids.

**`--no-ticket` is the way out, and it exists because a stop needs one that is not a payload.** The
key came from a real pull request, but the tracker may not hold it, or the agent may not reach it,
and without an exit the same ask fires on every rerun forever. Passing it runs the whole review with
ticket-fit ungraded and the reason on the record: the brief prints `ticket-fit not graded:
--no-ticket`, naming the key, which is a different sentence from "no ticket was supplied by the
host" and deliberately so. That one is equally true of a review nobody ever asked. This one says
somebody looked. `--json` carries the distinction as `ticketDeclined` beside `ticketSkipped`, the
same silence-versus-statement rule `--hazards` and `spinesCurated` keep.

Under `--json` this block is its own document: `awaiting: "ticket"`, `id`, `host`, `key`, `keyFrom`
(`title`, `branch` or `body`), `payloadPath`, `command`, `declineCommand` and `instructions`.

Flags: `--base <ref>` (pin the comparison base, critical for stacked PRs), `--findings <path>`
(run phase 2 over that file), `--pr-payload <path>` and `--ticket-payload <path>` (the pull request
and ticket an `mcp` host fetched, as JSON, at the paths the request block named), `--post` (post the
verified findings to the PR, off by default, and unavailable on an `mcp` forge, which declares no
`post` capability), `--readonly` (no posting, no mutating forge action: passing it together with
`--post` is a config error, and nothing else in a review writes anything), `--json`, `--no-workflow`
(leave the discipline out of the brief, for a reader who already has it), and `--repo <path>`.

## `empo update`

Regenerates the host wiring from this project's config, so it names this repository's roots and their
languages, its forge and its tracker, and states what a review cannot know when either is absent. Run
it after upgrading EmPo or after changing the config. This is the OpenSpec-parity command. Flags:
`--repo <path>`.

**Three targets, not one.** The managed block in `AGENTS.md`, the `.claude/` configuration, and the
`.codex/skills/` tree. Both host trees contain the three `empo-*` skill files, which are EmPo's own
and are written whole. Claude also receives hook entries merged into a `settings.json` that belongs
to the repository. In the merged files EmPo owns a part and not the whole, and it identifies its part
two different ways because the formats allow different things: marker comments in markdown, and a
content rule in JSON, where an entry is EmPo's only if its `type` is `"command"` and its `command`
contains `"empo hook "` either at the start or immediately after a path separator. The generator
writes only the bare command; the rule stays wider so it still claims the older path-qualified
spelling a wired repository carries, and regeneration replaces that entry instead of adding a second
hook beside it. See
[10-distribution](10-distribution.md) for what that rule costs and what the command reports when it
takes something out and cannot put it back.

**It regenerates a managed block, not a file.** EmPo owns what lies between `<!-- empo:begin -->` and
`<!-- empo:end -->` and nothing else, because many repositories already have an `AGENTS.md` a human
wrote and regenerating it wholesale would delete their work. A file with no markers is appended to,
never replaced; every later run finds the markers it wrote and replaces in place. Anything other than
exactly one pair in order is refused, with a count of what was found and how to fix it, rather than
guessed at: replacing the first pair would leave a stale second copy of the very instructions the
block exists to keep current, and replacing everything from the first marker to the last would delete
whatever a human wrote between the pairs.

It is idempotent and says so. A merge that comes out identical to what is on disk is reported
`unchanged` and the file is not written at all, which is what makes the command safe to run from a
hook or a CI step: it never dirties a checkout it has nothing to change. For `settings.json`
"identical" is decided on the parsed document rather than on the text, because serializing is lossy
for formatting and comparing the text would make the command reformat a file it had no change to
make. The other side of that coin is that a change EmPo does have to make reprints the whole document
and normalizes its formatting.

The block deliberately does **not** copy the review discipline. It says that `empo review` prints the
discipline and that the agent runs what it prints, because the copy `empo review` hands over is the
one the verification gate is built around, and a second copy would drift from it. See
[10-distribution](10-distribution.md) for what the block contains.

## `empo upgrade`

Replaces the running standalone binary with the latest GitHub Release. It resolves the latest
release, compares its version against the running one, downloads the asset for this platform and
architecture together with its `.sha256`, verifies the checksum, and swaps the binary in place. Run
it when you want a newer EmPo; nothing runs it for you.

```bash
empo upgrade            # resolve, verify, replace
empo upgrade --check    # say what would happen, write nothing
empo upgrade --json     # the same answer as one document
```

**It is the only command in this document that makes a network request of its own**, for the reason
the top of this file gives, and the whole of it is three GETs against `api.github.com` and the
release asset host: the latest release, the asset for this platform, and the asset's hash. It reads
no `.empo/`, opens no graph, and sends nothing anywhere. `empo review` is the only other command that
reaches a network at all, and it does so by running the user's own `gh`, which is their credential
and their connection and not one this tool opened.

**The checksum is verified before the downloaded file is allowed to become `empo`, and that is not
optional.** What is being fetched is an executable that will then run on this machine with this
user's permissions, on a path a shell resolves by name. A download that is truncated, cached wrong,
or served by something that is not the release host produces a file that looks like a binary, and the
only cheap way to know it is the file CI built is the hash CI published beside it. A mismatch stops
the upgrade with the running binary untouched and prints both hashes, because the two failures a
mismatch stands for, a corrupted download and a substituted file, call for different responses and
only a human can tell them apart.

**What that check is worth is worth being exact about, because the hash arrives over the same
channel as the binary.** Anybody who can serve a forged asset can serve a matching `.sha256` beside
it, so this defends against a truncated or corrupted download and against a stale cache serving the
wrong bytes, and it does not defend against a compromised release host. Closing that gap needs a
signature checked against a key that did not travel with the download, which is not built and is
recorded as not built rather than implied by the presence of a checksum. The check still earns its
place: it is the difference between running a file that is definitely the published one and running
whatever arrived.

**The swap is a rename inside the target directory, over `process.execPath`.** The new binary is
written to a temporary file beside the one it replaces and then renamed onto it, so the replacement
is atomic and never leaves a half-written `empo` on PATH: a rename within one directory is one
filesystem operation, where writing over the file in place has a window in which the command exists
and does not run. Beside it rather than in the OS temp directory, because a rename across filesystems
is a copy and gives that window back. Replacing a file that is currently executing is fine on macOS
and Linux, where the running process holds the old inode until it exits.

**It refuses in two situations, and prints the repair that fits rather than a generic failure.**

- **This is not the standalone binary.** Running from the tsup bundle (`dist/empo.js`) or from a
  checkout, self replacement is the wrong repair and would put a binary where a build expects its own
  file. Either one is upgraded with a pull and a rebuild, and a machine that wants the shipped tool
  runs the install script ([10-distribution](10-distribution.md)). It exits **2**: nothing is broken,
  the request does not fit this build.
- **This is Windows.** A running executable cannot be replaced there, so the rename this command is
  built on is not available. It says so and names the manual download instead of failing partway
  through, and exits **2** on the same reasoning. Stating the limit is the whole of the handling;
  there is no fallback that quietly does something else.

`--check` resolves and compares and writes nothing, which makes it the safe thing to put in front of
the upgrade and the thing to run when the only question is which version is current. **It exits 0
whether or not an upgrade is available**, because being out of date is news and not a gate, and 1 is
reserved for the four mechanical gates ([the exit-code table](#exit-codes)). Both refusals above
still apply to `--check`, and for the first one that is deliberate: a bundle asking whether it can
upgrade gets the same answer as a bundle trying to.

Under `--json` the answer is one document carrying the running version, the latest version, whether
an upgrade is available, the asset name, the target path and, after a real upgrade, the verified
hash. The prose says the same things; neither computes anything the other does not, so they cannot
disagree about whether this build is current.

Flags: `--check` and `--json`. There is deliberately no `--force` and no version selector. A binary
older than the running one is not something this command installs, because the only reason to want
one is a bad release and the repair for that is a download naming the tag, which
[10-distribution](10-distribution.md) records as `EMPO_VERSION` on the install script. Two commands
that can both write `empo` should not both grow a version argument.

**Neither this command nor the install script can succeed yet.** No release has been cut, so there
are no assets to resolve, and both become live on the first release
([10-distribution](10-distribution.md)).

## `empo doctor`

Health check, and it writes nothing. It does execute one thing, and only one: each hook the host is
wired to run, through a shell, which is a checkout-supplied command line and is why `--skip-hooks`
exists (the hooks block below states that boundary in full). Reports: graph staleness vs HEAD, config validity (bad roots, unknown
pack, malformed bridge, uncompilable `keyPattern`, an `aliases` target pointing at a directory that
is not there), directories under no root, a match rate per join,
both the configured bridges and a pack's own (a low rate usually means a mis-tuned `normalize`), any pack-version or graph-schema drift
against the binary that would make the graph on disk answer differently from a rebuild, what the
`adapters` block declares and whether this machine and this checkout can honour it, whether every
hook the host is wired to run actually runs, and whether the config's `commit` list still describes
what git does with `.empo/generated`. It says nothing about test coverage: which flows nothing
asserts on is `empo query --blind`, and doctor computes no coverage of its own. It also prints a
spines line: how many spines there are, how
many citations they state, and whether every anchor still resolves. Spine drift is a warning here and
never an error, because `empo verify` is the command that exits 1 on it and a rotted spine still
answers, loudly and in one place; a spine file that will not parse is a config error like any other.

**A forge line and a tracker line always print**, between the bridges and the spines, including the
two states nothing used to say out loud: a forge nobody configured and a tracker nobody configured,
which is what "ticket-fit was never graded" looks like from the config side. Where a forge is
configured the line names the kind and its `host`, the `OWNER/REPO` slug exactly as the adapter
builds it, whether the CLI is on PATH where the kind needs one (`gh`, for `github` and for
`github-issues`; `mcp` and `local` reach no binary at all), and what the `origin` remote says, either
`origin agrees` or the host and slug it really points at. `not configured` and `local` are printed
apart, and so are `not configured` and `none` on the tracker: both members of each pair end in a
review of the local diff or a review that grades no ticket, and only one of them was somebody's
choice.

Nearly all of that is a fact rather than a finding, and the split is the SessionStart hook's doing:
the hook prints every finding doctor produces, on every session, so a finding raised on a steady
state is a hook somebody uninstalls. A finding is raised only where the config asks for something
this machine or this checkout cannot give it, which is three things, plus the hooks block below,
where what asks for something is the host's wiring rather than the config. Every one of them is a
warning, so nothing doctor finds moves its exit code. Two are the adapters' and
print in this block: a `github` forge or a `github-issues` tracker whose `gh` is not on PATH, each
stating its own consequence, and an `origin` whose **kind** disagrees with the configured forge
kind on a host detection knows by name, which is github.com, bitbucket.org, gitlab.com and their
subdomains. On a host it does not know,
`github.acme.com` and every other Enterprise install, mirror or ssh host alias, the same
disagreement is printed as a fact and raises nothing, because each of those is a working setup
whose kind detection cannot infer. A checkout whose git only *rewrites* the remote is not one of
these: detection reads the configured url, so an `insteadOf` rewrite never reaches the comparison.
One whose remote url **is** the proxy or the mirror still lands here, and still raises nothing.
Both findings are warnings, so no adapter ever makes doctor exit non-zero. The third is a root's
`aliases`, raised with the config findings above rather than here: a target whose **literal parent
directory** is not in the checkout is warned about, because the whole cost of a wrong alias is
silence, since nothing fails, the import resolves to no node, and the file it named comes out at a
fan-in counting only its relative importers. Only the directory above the wildcard is checked and
never the whole target, since a target names a module the pack's extensions and index names still
have to resolve, so a perfectly good alias would fail an `existsSync` on the path itself. That
under-reports on purpose, on the rule the whole section follows: a finding that fires on a working
config is a finding somebody turns off. It is a warning too, so `empo index` still builds and doctor
still exits 0. A slug that disagrees
with `origin` is printed beside it and never warned about, because a fork workflow has `origin` on
the fork and the config on the upstream and the human is the one who can tell that from a mistake.
`host` is free text the engine may not branch on, so it is never compared at all. Where git cannot
answer there is no origin clause at all, because an unread remote may not be reported as agreement.

**A hooks line prints after the forge and tracker lines**, closing the wiring group, and it is the
one line in the report that had to run something to know what it says. It takes one of three shapes:

```text
hooks      none wired, so no session runs empo
hooks      3 wired, all ran clean
hooks      3 wired, 2 ran clean, 1 broken (named below)
```

Doctor executes each wired hook the way the host runs it, because the hooks fail open by design
([10-distribution](10-distribution.md)), and a hook whose command cannot be found is therefore
silently indistinguishable from a clean repository: nothing is printed, no session complains, and
the first person to find out is whoever expected a denial that never came. `empo --version` is not
the check it looks like either. It is typed in an interactive shell, and an interactive shell is the
one environment where a PATH problem never appears.

It reads the EmPo-owned entries out of the repository's `.claude/settings.json` through the same
ownership rule `empo update` merges by, the one on the `command` string described under that command
above, so what doctor probes cannot disagree with what a regeneration would strip. Every unreadable
state is `none wired` rather than an error: no file, JSON that will not parse, no `hooks` key.

Each command is run through a shell, because a shell is what the host runs it through, with
`CLAUDE_PROJECT_DIR` set to the repository root, because that is the variable the host expands
inside the command string, and with stdin closed, so the hook reads EOF instead of an event and has
nothing to answer while the run still proves that its command resolves and starts. The hook's own
configured timeout, in seconds in `settings.json`, is the budget, since that is exactly when the
host would kill it. Exit 0 is healthy. Exit 127 is the shell's own answer for a command it cannot
find, so it is reported as not found rather than as a failure, because those are two different
repairs. Any other non-zero is a failure, and a run past the budget is a timeout.

**Every broken hook is a warning**, exactly as the adapter findings above are, and doctor still
exits 0. What was broken here was the silence and never the exit code: doctor naming each broken
hook out loud, and saying which failure it hit, is the whole of the repair. Exiting non-zero would
break every environment where the hooks are irrelevant but doctor is legitimately run, and CI is
the plain case: no agent session ever runs there, this repository's own hooks are wired to the bare
`empo` spelling CI never installs, and CI additionally runs doctor under a deliberately stripped
PATH to prove the binary needs no Node. A check that is permanently red in those places is the same
false gate this feature exists to remove, only inverted. It is the precedent too: a hook command the
shell cannot find is the same kind of fact about this machine's PATH as a `gh` that is not on it.
The line itself only counts, because each broken hook is named on its own below the fact block, with
its event, its command and the repair its particular failure asks for. A hook that ran clean says
nothing. And what the whole block reports on is the machine that ran it, so it is no mitigation for
a teammate who never runs `empo doctor` at all.

**`empo doctor` is the only thing that ever executes a hook.** The SessionStart hook reaches the
same health report with the probe left off, because a hook that ran the hooks would recurse into
itself, and because the work does not fit the ten seconds the host allows a session to start in. So
a healthy session still opens in silence and still spawns nothing.

**Running a hook means running what the checkout says.** Every other line in this report is a file
read, and this one is not: each wired `command` string is handed to a shell whole, so pointing
`empo doctor` at a repository executes whatever that repository's `.claude/settings.json` puts in
those strings, shell syntax and all. Ownership is decided by the **shape** of the command and never
by a signature: an entry is EmPo's because it contains `empo hook`, which is what lets `empo
update` merge without trampling a hand-edited entry, and it is also what makes a modified entry
still ours. `empo hook session-start; <anything>` matches the ownership rule, is listed as a wired
EmPo hook, and is run. A checkout can therefore choose what `empo doctor` executes on the machine
that runs it.

The honest mitigation is that this is not a new capability on that machine. The same string is what
the Claude Code host would run at the next SessionStart, off the same file, through the same shell,
so anybody who opens a session in that checkout has already granted it. What moves is the
**ordering**, and that is the part worth naming: doctor is documented as a health check that makes
no changes, and it is exactly the command somebody runs *before* opening a session, against a fresh
clone or a branch they have not read, to decide whether the repository is in a state worth working
in. A command reached for at that moment should not be the first thing to execute the repository's
own instructions.

So `--skip-hooks` is the answer for a checkout you do not trust yet: it reports on the wired hooks
without running any of them. The hooks line becomes `hooks      N wired, not run`, which is the same
state the SessionStart hook reaches, and no hook findings are raised, because nothing was observed
and a clean report about an unexecuted command would be the verified-looking answer this whole block
exists to prevent. Which hooks are wired is still printed, since that half is a file read and costs
nothing, and every other line of the report is unchanged. Read it, read `.claude/settings.json`, and
run doctor again without the flag once you are willing to open a session there.

Hooks are a Claude Code concept. Codex gets the skills and `AGENTS.md` and no hooks at all, so a
Codex-only repository reports none wired, which is a fact about that host and never a fault.

**A flows line prints under the graph line**, and it is a count rather than a verdict: how many flows
the graph was built with, and how many of the non-test files in that graph no flow claims
(`8 defined, 9 of 65 non-test files claimed by none`). It exists because a flow list is layer 2 and a
human owns it, so a new module joins the graph and belongs to no journey until somebody remembers,
and until this landed nothing anywhere printed that. It is a fact and never a finding, for the reason
the adapters block is: files are unclaimed on purpose in most repositories, this one included, and a
warning that fires forever on a deliberate state is a hook somebody uninstalls. Whether the number is
the right number is the human's judgement, exactly as with `--orphans`.

The denominator is the non-test files **the graph holds**, not the files on disk: a file no root
scans was never a candidate for a flow, and a directory under no root is already its own finding
above. Test files are out because `assignFlows` never puts a test node in a flow whatever prefix
would claim it ([05-graph-model](05-graph-model.md)), so counting them would print a total that can
never reach zero. Without a readable graph every field is `null` and the line reads
`flows      unknown until the graph is built`, never a zero, because "no file is unclaimed" and
"nothing was counted" are opposite answers and only one of them is good news.

**A names block prints under the flows line**, one line per edge family whose rules resolve a bare
name, and it is a count of the same kind. On this repository's fixture:

```text
names      hook     2 of 2 resolved
names      template 1 of 1 resolved
```

Only the `short-name`, `observer` and `view` strategies resolve a name the source wrote rather than
a path the filesystem answers ([04-language-packs](04-language-packs.md)), and all three refuse a
name carried by more than one node. Until this landed the first two refused it **silently**: one duplicate basename anywhere in a
root removes every edge to that name, including the ones written in a file whose own import says
which is meant, and nothing counted or printed that, so a family whose yield had gone to zero read
exactly like a family with nothing to find. The block counts that refusal. **It does not narrow
it** — the same names are refused as before, and the change is that the ratio is now on the record.

`short-name` consults the index twice: the exact spelling first, and only where no node carries it,
the index again with the name lower-cased. A file naming convention is not a language — `<Badge />`
is written `Badge.tsx` in one React repository and `badge.tsx` in the next, and both are a component
the graph holds — and the exact map going first means a repository that spells its files as it spells
its tags resolves before the fold is ever asked and can never be answered by it. A folded candidate
also has to be **corroborated by the rendering file's own imports**: it stands only where that file
imports this name from a specifier that resolves to that very file, relative path or configured alias.
An exact match needs no such witness, because a tag spelled exactly as a file is the language's own
convention answering, while a fold is the engine guessing a naming style is in play. A fold nothing
corroborates counts as `in no node` rather than `ambiguous` — it was never admitted as a candidate, so
nothing was weighed — and since the witness is asked per candidate and before the uniqueness test, a
name two files carry once case is set aside still resolves where the reading file imports exactly one
of them. `targetKinds` narrows whatever the fold admitted before that uniqueness question rather
than after it, exactly as it does for the exact map. On the 186-file React Native application above,
whose components live in `src/components/badge.tsx`, `template` went from 3 of 1531 tag references
resolved to 735 of 1531, and not one of the 1528 misses had been an ambiguity anybody could have
repaired by renaming a file. **This is why a `names` yield can jump between runs of two empo
versions without a line of the repository changing.**

What corroboration is worth was measured on cal.com, which names its shadcn-style files
`toaster.tsx`, `collapsible.tsx` and `textarea.tsx`: the uncorroborated fold produced 53 extra
template edges there and a sample of 6 came out 5 wrong — `<Toaster />` imported from `sonner`
landing on the local `toaster.tsx`, `<Collapsible>` from `@radix-ui/react-collapsible`, `<TextArea>`
from a `@calcom/ui` barrel whose real file is `inputs/Input.tsx`. Corroboration removed 46 of those
edges, all five refuted ones included, and kept the real one (`apps/web/app/layout.tsx:167 ->
apps/web/app/providers.tsx`, imported as `./providers`); on the React Native application 12 of 12
sampled edges survive and each was opened at its cited line and confirmed real. One consequence to
know: a component rendered with no import at all — a globally registered Vue component — is reachable
through an exact-name match and never through a fold, since there is no import to corroborate it.

A tag whose component comes from a package used to resolve to a local file whose basename collided
with it **exactly** — react-native's `<Text>` in a repository holding `src/components/Text.tsx`
became an edge to a file that line does not render, and that was 189 of react-admin's template edges.
It is refused now, as `imported from a package`: the repository's own manifests say which names are
packages it depends on and are not itself, and a name the reading file imports from one of those is
declined even though the index holds exactly one node for it, of the right kind
([04-language-packs](04-language-packs.md)). The yields the current runs print: react-admin 7409 of
17415 references resolved with 3142 ambiguous, 5617 in no node, 527 of the wrong kind, 213 declared
where they are used and 507 imported from a package; excalidraw 563 of 1264, cal.com 2777 of 5917,
the React Native application 735 of 1531. Those numbers have moved in both directions across two
builds and neither move is a regression: the refusals took react-admin from 7672 down to 7165,
because those references were resolving to the wrong file, and the workspace redirect below took it
back to 7409 by answering names the index had to refuse. That is the point of the block, since a
reader who can see 7409 of 17415 knows what weight to put on an answer built out of them.

A name imported from another **workspace** package of the same monorepo used to land wherever the
basename fell, since a workspace is a name the repository is and can never be refused as a vendor
one: cal.com's `WebhookListItem.tsx:222` imports `Button` from the internal `@coss/ui` and the edge
landed on `packages/ui/components/button/Button.tsx`. The manifests also say where `@coss/ui` lives,
so the nodes under `packages/coss-ui` are searched first and the edge now lands on
`packages/coss-ui/src/components/button.tsx`. It resolves rather than refusing, so no clause counts
it, and the search is a preference and not a requirement: a name the named package carries nowhere
falls through to the index untouched, which is what keeps a re-export barrel such as react-admin's
own working.

What still gets an edge it should not: a dotted tag contributes its head, so excalidraw's
`<DropdownMenu.Trigger>` reaches the file holding the namespace object rather than the one holding
the component.

A family that refused something adds a clause per refusal it made: `, N ambiguous` for a name several
nodes carry, `, N in no node` for a name no node carries (a vendor component, a Blade built-in like
`<x-slot>`), `, N of the wrong kind` for a name every node carrying it holds under a kind the rule's
`targetKinds` does not list, `, N declared where they are used` for a name the file that wrote
the reference declares itself, through the pack's `declares` patterns, and
`, N imported from a package` for a name that file imports from a package the repository depends on,
through the pack's `packages` block ([04-language-packs](04-language-packs.md)). The last two are
asked **last**, of the one name that had survived the other three and was about to become an edge,
because that is the only case either can change: a name in no node was never at risk of a wrong edge
and its honest verdict is `in no node`, whatever the reading file declares or imports. What is left
is the case both exist for — the index found exactly one node, of a kind the rule allows, and the
file that wrote the reference says it meant something else. They are the two refusals that prevent a
wrong edge rather than losing a right one, which is why each is worth a clause rather than being
folded into `in no node`: measured on marmelab/react-admin, 213 references are a file shadowing the
name it renders with its own declaration and 507 are a component imported from a package, and before
these they were edges pointing at somebody else's file.

A clause for a refusal that did not happen is left out, because the
denominator has already stated that zero and five `0 ...` clauses on every healthy family is what
gets a line skimmed. Where a family has ambiguous names, an indented second line names them,
`"OrderTable" (2 files, 5 references)`, most references first and then most files, five at most with
`, and N more` for the rest. That second line is what makes the count actionable: the number says the
family is losing edges, and the names say which rename would give them back.

**The denominator prints even when nothing was refused**, which is why the fixture's two clean
families still print `2 of 2` and `1 of 1` rather than nothing at all. A family reporting
`41 of 41 resolved` and one reporting `0 of 53 resolved` are opposite results and the total is the
only thing that separates them, so a number appearing only once something had gone wrong would be a
number nobody had a baseline for at the moment they needed one. It is the argument `--blind` makes
for `flowsConsidered` above.

Two states get a sentence instead of numbers, and they are not the same state.
`names      unknown, no run has counted them (run empo index)` is no readable graph, or a graph
written before the count existed, both of which are "nobody counted". It names the repair rather
than the state, because those two are one repair and the graph and drift lines above have already
said which one it is: the flows line beside it can say "unknown until the graph is built" only
because nothing but a missing graph reaches its null, and saying that here would tell the reader of
a perfectly readable graph to go and build the graph they are looking at.
`names      no name-resolving rule read a name here` is counted, and nothing read a bare name — a
different fact, and precisely the one this block exists to tell apart from a family that read names
and resolved none of them. Collapsing them would recreate the silence inside the field built to end
it.

It says no rule **read** a name rather than that no rule resolves by name, because those are two
causes of one empty list and this repository is the second. EmPo's own root is typescript, whose
pack declares two `short-name` template rules, and both carry `pathGlob: "**/*.{tsx,jsx,vue}"`,
which matches no file in a repository with no components in it. The rules exist, they resolve by
name, and they read nothing. Which of the two causes it is, is a question about the pack rather than
about the graph, so the line states the fact it has and claims neither.

Like the flows line it is a **fact and never a HealthFinding**, on the rule this section already
gave: the SessionStart hook prints every finding doctor produces on every session, ambiguous
component names are the normal shape of a React tree with feature directories and a `TextInput` under
two namespaces is the normal shape of a Blade component library, and a warning that fires forever on
a deliberate state is a warning somebody uninstalls. The number is the whole of the answer, and
whether it is the right number is the human's judgement.

The `commit` check asks git with `git check-ignore` rather than parsing `.empo/.gitignore`, so a
rule in the repo's root `.gitignore` counts too. It reports both directions: `commit` records
`generated` as committed while git ignores `.empo/generated`, or git does not ignore
`.empo/generated` while `commit` records nothing as committed. It is a warning and never an error
for the same reason spine drift is, the record has stopped describing the repository while every
answer EmPo gives is still correct. It stays silent when there is no `.empo/.gitignore`, when
`.empo/generated` is not on disk (a directory rule cannot match a path that is not there, so a repo
that has never been indexed is never reported), and when there is no git checkout. Editing `commit`
still changes no behaviour: it adds and removes no ignore rule, and `.empo/.gitignore` is what git
obeys. This is the first thing to run when an answer looks wrong.

Flags: `--repo <path>`, `--json`, `--skip-hooks`. The last one is the trust boundary above and not
an output choice: it is what to pass at a checkout whose `.claude/settings.json` you have not read.
The JSON form exists because the SessionStart hook needs a health
answer it does not have to parse out of prose, and a hook that reads sentences breaks the first time
one is reworded. Both surfaces render one computed object and neither calculates anything of its own,
so they cannot disagree about whether the graph is stale, which is the failure that would matter: a
human told the graph is current while the hook is told it is not is worse than either answer alone.
Under `--json` nothing but the document reaches stdout, and a config error is still exit 2 with its
message on stderr, so the document stays parseable.

## `empo hook <event>`

The host's half of the wiring in [10-distribution](10-distribution.md), and the one command here
whose output is read by a machine rather than by a person. Three events, one command, because the
alternative is a shell one-liner inside generated JSON, and the hook contract belongs in code where
it is tested.

```text
empo hook session-start    a graph behind HEAD, a drifted spine, a root or pack that is not there
empo hook pre-edit         deny a write under .empo/generated/, warn on a spine's guarded file
empo hook pre-commit       run the commit gate over the staged diff and deny a commit that fails it
```

It reads the hook payload as JSON on **stdin** and writes its answer as JSON on **stdout**. The one
flag is `--repo <path>`, which the generated `settings.json` fills from `${CLAUDE_PROJECT_DIR}`; the
payload's own `cwd` is the fallback, and this process's working directory after that. A closed stdin
is EOF and not an event, which is what lets `empo doctor` run every wired hook as a liveness probe:
the command resolves, starts and exits, with no event to answer. Doctor is the only caller that runs
these outside a session, and its own section above says why it has to.

Four rules, and they are one idea: a hook that speaks on the happy path is a hook that gets deleted.

- **On the happy path it prints nothing and exits 0.** Every event fires on every session or every
  edit, so anything printed routinely is noise a team learns to skip and then removes. This is the
  one command in this document that says nothing when all is well, and the reason is that it is the
  one command nobody asked a question.
- **A repository with no EmPo config is silent.** No config, a config that will not parse, no graph
  built yet, no git: each is caught and answered with nothing, on every event. A hook is not the
  place to teach somebody `empo init`, and a hook that errors on every tool call in an unrelated
  repository is uninstalled within the hour. The single rule decided before the config is read is the
  machine-owned directory, because a path under `.empo/generated/` is that path whatever else the
  repository does or does not hold. Note where the silence stops: a config EmPo *can* read but whose
  roots, packs, bridges or spines do not check out is a finding, and SessionStart says so, because
  that is a repository somebody is working in and getting wrong answers from.
- **It never exits non-zero, not even to deny.** A denial is structured JSON on stdout with exit 0,
  carrying its own reason and repair: for a commit, the spine, the guarded files that changed, the
  terms it wanted and the bypass; for a write under `.empo/generated/`, that only `empo index` writes
  there and that the fix is the config or the pack and a reindex. Exiting 2 would discard stdout and
  route a bare string through stderr, which is the poorer channel for the one message a denial has to
  land. So the exit-code table below does not describe this command: it has one exit code.
- **It reimplements no gate.** `pre-commit` calls the same function `empo check` renders, over the
  same staged diff. Two implementations of one gate disagree eventually, and the day they disagree
  is the day somebody stops trusting the gate.

## Exit codes

Consistent across commands so they compose in CI and hooks:

| Code | Meaning |
|------|---------|
| 0 | success, nothing to flag |
| 1 | a gate failed (`check` found an unguarded spine change, `verify` found drift, `index --check` found staleness, `pack test` found a fixture-snapshot mismatch) |
| 2 | usage or config error (bad flags, invalid `config.json`, missing pack, a ref this repository does not know, a host payload that will not read or does not check out against git, an `upgrade` asked of a build that cannot replace itself) |
| 3 | environment error (an adapter's CLI is missing or unauthenticated, git itself could not produce the diff, `upgrade` could not reach GitHub, found no release asset for this platform, failed the checksum, or could not write the target path) |

`empo review` never fails the build on its findings; a review reports, it does not gate. Only the
mechanical gates (`check`, `verify`, `index --check`, `pack test`) return 1. `empo hook` sits outside
this table entirely and always exits 0, for the reason its own section gives: its answer, denial
included, is the JSON document on stdout.
