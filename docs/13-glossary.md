# 13. Glossary

Shared vocabulary used across every doc. When a term is capitalized or quoted elsewhere, its
definition is here.

**Adapter.** A thin, uniform interface that lets the review run against a specific host. Two kinds:
forge (PR host) and tracker (ticket system). Adding a host is implementing the interface, not editing
the discipline. See [09-adapters](09-adapters.md).

**Anchor.** A distinctive substring recorded next to a `file:line` in a spine, so `empo verify` can
detect when that line has moved or the claim has rotted. The basis of drift detection.

**Blast radius.** The set of end-user flows a change to a given symbol can reach. Answered by
`empo query` from the generated graph. The core question EmPo exists to answer.

**Blind flow.** A flow that reaches a piece of code (is exercised) but has no test that asserts on
the value that code produces. A wrong result ships silently there. Printed in capitals by
`empo query` because it is the most important thing in the answer.

**Bridge (symbol join).** A coupling resolved by matching produced symbols against consumed symbols
(level 2 coupling). Two different things declare one. A `bridges` entry in `config.json` is a human's
claim that two roots exchange a symbol, and is the mechanism that lets a backend change report its
mobile blast radius. A pack's `joins` is the pack's claim about its own framework, matched inside a
single root and needing no config: the php pack joins `scheduled-command`, so a Laravel scheduler
entry and the command class whose `$signature` it names are the two ends of one bridge edge and both
of them are php. **So a bridge edge is not always cross-language**, which is why `empo query` heads
the section "symbol joins", `empo review` labels the rows `join <symbol>`, and `empo index` and
`empo doctor` report match rates as `join <kind>`. See [03-config-schema](03-config-schema.md) and
[04-language-packs](04-language-packs.md).

**Coupling levels.** The three ways code connects: intra-language (imports, level 1), symbol matching
(a produced key against a consumed one, level 2 — across a language boundary for a configured bridge,
inside one root for a pack's own `joins`), and flow (an end-user journey spanning both, level 3). See
[01-architecture](01-architecture.md).

**Discipline.** Layer 3: the universal, shipped review workflow. Language- and host-independent. Its
governing rule is that no finding reaches a human unverified, and none that this pull request did
not introduce reaches them at all. See [07-review-discipline](07-review-discipline.md).

**Drift.** A spine `file:line` whose anchor no longer resolves against current source, making the
claim resting on it fiction. Detected by `empo verify`; warned at session start.

**Edge.** A directed coupling between two nodes in the graph, with a kind (import, fqcn, string,
template, hook, inherit, bridge) and `file:line` evidence. See [05-graph-model](05-graph-model.md).

**Fan-in.** How many distinct nodes reference a node: how many things depend on it. The headline
blast-radius number. High fan-in nodes are "gods." Nodes and not edges, because one file can
reference another through two rule families at once (it imports a component and then renders it),
and that is one thing depending on it. See [05-graph-model](05-graph-model.md).

**Fan-out (dispatch inside a loop).** A queued job dispatched from inside a loop, so one request can
put an unknown number of messages on the queue. Found lexically, from the `loops` rules a language
pack declares in its optional `hazards` block, carried in the graph's top-level `fanout` list and
reported by `empo review`, which prints the sites in the changed files as a section of the phase-1
brief and carries the same list under a top-level `fanout` key in `--json`. **It is a fact and never
a finding**: a dispatch in a loop is how a batch is written, and how often the loop runs is a
property of the data and not of the source, so EmPo states the coordinate and the reviewing model,
which can go and read the query, decides — through the same verification funnel as every other
finding. A graph built before the axis holds no list at all, and that is reported as unknown rather
than as none, the same distinction the `hazards` axis keeps. See
[04-language-packs](04-language-packs.md).

**Flow.** An end-user journey that state or value travels through, defined as a list of paths that may
cross roots. The unit the blast radius is reported in. Human-owned in `flows.json`, proposed by the
agent at init. See [01-architecture](01-architecture.md).

**Forge.** The pull-request host: GitHub, Bitbucket, GitLab, or a local diff. Abstracted by a forge
adapter, of which there are three kinds rather than one per host: `github`, `local`, and `mcp` for
any host the agent reaches through its own connector.

**Generated (machine-owned).** Everything under `.empo/generated/`, written only by `empo index`,
never by hand or by an agent. The opposite of the curated, human-owned flows and spines. The
ownership split is enforced by a hook. See [02-on-disk-layout](02-on-disk-layout.md).

**God node.** A node with very high fan-in: changing it can reach a large fraction of the codebase.
Listed by `empo query --gods`.

**Ground truth.** The generated graph, the flow map, and the drift-checked spines: the verifiable
substrate that makes an agent's claims checkable instead of confident. The reason EmPo is more than a
prompt.

**Guarded (spine).** The globs a spine watches. A staged change touching them with no value-asserting
test fails `empo check`.

**Hazard (transaction hazard).** A queued job dispatched from inside a database transaction without
waiting for the commit, so a worker can run before the rows it needs exist. Found lexically, from the
markers a language pack declares in its optional `hazards` block, carried in the graph's top-level
`hazards` list and reported by `empo query --hazards`. A pack that declares no such block makes no
claim about the language, which is a different answer from a pack that looked and found none. See
[04-language-packs](04-language-packs.md).

**Introduced by (`introducedBy`).** The second citation every review finding carries: the diff line
that introduced or broke it, in the same `file:line:anchor` shape as the finding's own citation. For
a `diff` finding it is usually that citation; for an `impact` or `coverage` one it is the hunk whose
change reaches that far. Required, and checked against the pull request's own hunks: a finding the
branch inherited is dropped as `not-introduced`, because a review that reports inherited defects is
reviewing the repository and not the diff. The finding's own citation is scoped the same way, by
kind: a `diff` or `coverage` finding standing outside every hunk is dropped as `cited-outside-diff`
and an `impact` finding standing inside one as `cited-inside-diff`, so naming a neighbouring hunk as
the cause does not carry an inherited defect through. An anchor that fails is checked against the lines the
diff removed before it is dropped, since deleting a file or a method breaks its consumers without
leaving anything in the new source to cite; the file and line are then coordinates in the base, and
every report of them says so. See [07-review-discipline](07-review-discipline.md).

**Invariant.** A statement that must remain true after a change to a spine (for example, line totals
sum to the header). Best cited to an executable check in the codebase rather than stated in prose.
See [08-spines](08-spines.md).

**Language pack.** The declarative rules, and only those, that tell the one
language-agnostic engine how to extract nodes, edges, and symbol tables for a given language. Adding
a language is a pack, not a new parser. See [04-language-packs](04-language-packs.md).

**Node.** A unit of code in the graph (a class, a module, a route file), with a stable id, a file, a
language, a kind, and its produced/consumed symbol lists. See [05-graph-model](05-graph-model.md).

**Root.** A directory in the repository indexed with one language pack. A monorepo has several; a
single-package repo has one. Declared in `config.json`.

**Spine.** A hand-curated map of one critical chain (money, auth, tenant isolation): its hops,
invariants, traps, guarded globs, and drift-checked citations. Complements the graph: the graph says
what connects, the spine says what must stay true. Most repos have zero or one. See
[08-spines](08-spines.md).

**Symbol table.** Per file, the list of symbols it produces (publishes) and consumes (references),
used to resolve bridges. A backend file produces the http-route it registers; a frontend file
consumes the http-route it calls.

**Tracker.** The ticket system (Jira, Asana, Linear, GitHub Issues) where acceptance criteria live.
Abstracted by a tracker adapter, of which there are three kinds rather than one per system:
`github-issues`, `none`, and `mcp` for any system the agent reaches through its own connector.

**Trap.** A verified gotcha in a spine, with a `file:line` and an anchor: a place where the obvious
change is wrong (rounding that depends on operation order, a bulk write that bypasses model events).

**Verification funnel.** The review step where every suspected finding is dispatched to an
independent check and only survivors are written up. The mechanism that enforces principle 2. See
[07-review-discipline](07-review-discipline.md).
