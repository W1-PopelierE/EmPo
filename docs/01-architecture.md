# 01. Architecture

EmPo is four layers with different owners, and a graph model that understands three levels of
coupling. Getting these two decompositions right is the whole design. Everything else is detail.

## The four layers

```text
┌─ 4. ADAPTERS ──────────────────────────────────────────────────────────┐
│   config, per project. Makes EmPo run in someone else's repo at all.    │
│   forge: github | mcp | local             tracker: mcp | github-issues  │
│   language packs: php | typescript | python | go | ...                  │
├─ 3. DISCIPLINE ────────────────────────────────────────────────────────┤
│   markdown, shipped, project-independent.                               │
│   the review workflow, the verification funnel, the forbidden phrasings │
├─ 2. SEMANTIC ──────────────────────────────────────────────────────────┤
│   AI proposes at init, a human owns and approves.                       │
│   flows.json (which user journeys exist)                                │
│   spines/*.json (critical chains: hops, invariants, traps, citations)   │
├─ 1. MECHANICAL ────────────────────────────────────────────────────────┤
│   CLI, deterministic, NO LLM. Seconds, not minutes. No network.         │
│   the import/reference graph, fan-in, flow mapping, test cross-ref,     │
│   drift checks, the commit gate                                         │
│   -> .empo/generated/graph.json   (machine-owned, never hand-edited)    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why the layering matters

The layers map exactly onto how much of EmPo is universal versus specific:

- Layer 1 is **language-specific but project-independent**. The graph builder is one piece of
  language-agnostic code driven by per-language packs (layer 4). It knows nothing about your
  business.
- Layer 2 is **project-specific**. Your flows and your spines are yours. EmPo proposes them; you
  own them.
- Layer 3 is **fully universal**. The verification funnel does not care what language or business
  it runs against.
- Layer 4 is **the reason it ports at all**. Swap the forge adapter and the same review runs
  against GitLab instead of GitHub, which since the `mcp` adapters landed is a config line and not a
  new adapter. Add a language pack and the same graph builder indexes Go.

The single most important ownership rule: **`generated/` is machine-owned, everything else in
`.empo/` is human-owned.** The agent may extend `flows.json` and the spines as it learns (that
feedback loop is what keeps the semantic layer worth having). The agent may never hand-edit
`graph.json`. This is enforced by a hook, not left to prose (see [10-distribution](10-distribution.md)).

## The three coupling levels

A dependency graph that only reads imports sees one of the three ways code couples. In a
monorepo it misses the two that cause the expensive bugs. EmPo models all three.

```text
1. INTRA-LANGUAGE   import edges, resolved by a language pack
                    PHP:  use / inline \Acme\.. FQCN / Model::observe(...)
                    TS:   import / require / dynamic import()
                    -> the classic dependency graph, built per language, merged into one

2. INTER-LANGUAGE   string edges that cross the language boundary
                    a route path the backend DEFINES and the frontend CALLS
                    an event name, a queue name, a feature-flag key, a storage key
                    -> invisible to every import parser. this is the monorepo killer feature.

3. FLOW             an end-user journey, now spanning both languages
                    "place an order" = RN screen -> API path -> controller -> calculator -> model
                    one flow, two languages; the graph must see it as one chain
```

### Level 1: intra-language

This is the well-understood case. Each language pack declares how imports look in its language,
the builder runs those rules over that language's files, and produces edges. A PHP pack also
declares the non-import couplings that language has (an observer registered in a provider couples
two files that never import each other; a class-name string in `call_user_func` is a real edge; a
class extending a sibling in its own namespace writes no `use` statement at all, so the import rules
never see the strongest coupling in the file).
The php pack declares six such edge kinds: import, inline FQCN, class-name string, template
reference, hook registration, and inheritance.

### Level 2: inter-language (the differentiator)

Across a language boundary nothing imports anything. A React Native screen and a Laravel
controller share exactly one thing: a **string**. The route path `/api/v1/orders`.

EmPo resolves this with **symbol tables**. Each language pack, in addition to import edges,
extracts two lists from each file:

- **produces**: symbols this file publishes to the world. A backend file that registers
  `Route::post('api/v1/orders', ...)` produces the http-route symbol `POST api/v1/orders`.
- **consumes**: symbols this file references. A frontend file that calls
  `api.post('/v1/orders', ...)` consumes that same http-route symbol.

The builder matches produced symbols against consumed symbols across roots, and emits an
inter-language edge for each match. This is level 1's "class-name string" idea lifted to a
first-class, cross-language coupling. It is the same mechanism, aimed across the boundary.

The bridges you want matched are declared in config (`bridges` in [03-config-schema](03-config-schema.md)),
so the tool does not invent couplings you did not ask for. No bridge declared, and each root is
treated as an island, which is still useful, just not monorepo-aware.

One kind of match needs no config, and it is not across a boundary at all. A framework sometimes
spells one call twice in its own language — a Laravel scheduler entry names a command by a string
the command class declares as its `$signature` — and joining those two is a fact about the framework
rather than a claim about anybody's layout. A pack lists such symbol kinds in `joins`
([04-language-packs](04-language-packs.md)) and the same matcher runs them inside a single root. So
level 2 is symbol matching, and crossing a language is the common case rather than the definition:
without it a scheduled command is a class nobody calls, and the file that runs against production
every night reads as a leaf.

### Level 3: flows

A flow is an end-user journey, written as a list of paths that may cross roots, so one journey
covers both the API and the mobile app. Restricting a flow to one language would be the obvious
simplification and it is the wrong one. This matters directly: without it, `empo query` on a backend change would
report "these backend files break" and stay silent about the screen in the app that also breaks,
because the app reached the backend through a level-2 string edge, not an import.

## Data flow through the layers

```text
  repository files
        │
        ▼
  [layer 4: language packs]  select files, declare extraction rules
        │
        ▼
  [layer 1: builder]  intra-language edges + produce/consume symbol tables
        │             then match symbol tables across roots -> inter-language edges
        ▼
  .empo/generated/graph.json   (nodes, edges, flow assignment, test cross-ref, commit sha)
        │
        ├──▶ empo query <symbol>     deterministic impact answer (no LLM)
        ├──▶ empo verify             resolve spine citations, report drift
        ├──▶ empo check              commit gate: spine touched without a value assertion?
        │
        ▼
  [layer 3: discipline]  the agent runs the review workflow, reading the graph,
                         the flows, the spines, and the tracker ticket, and verifies
                         every finding before writing it.
```

The important property: everything below the discipline layer is deterministic and inspectable.
`empo query PriceCalculator` produces the same answer whether or not an agent is attached, and a
human can read it. The agent consumes that answer; it does not manufacture it.

### The one place a model-produced artifact enters the lower layers

The `mcp` forge and tracker adapters ([09-adapters](09-adapters.md)) are the exception, and naming it
here is more useful than letting a reader find it later. EmPo makes no network call and holds no
token, so it cannot reach a Bitbucket or a Jira: the agent fetches the pull request and the ticket
with its own connector and hands EmPo a JSON payload. That payload is a model's output arriving at
layer 4.

It is acceptable for one reason, and the design collapses without it: **the payload is checked
against something the model does not control.** Its branch names have to resolve to real commits in
this repository or the review refuses to start, and its head sha is compared against what the branch
actually points at. A hallucinated pull request has an id, a title and two plausible branch names,
and it has no branches that exist in git.

Two consequences worth holding onto. The diff, which is the one artifact a review reads line by line,
is still computed locally by git and never fetched, so no model has touched it. And the property
above survives intact for everything the graph answers: `empo query` never sees a payload at all.

## A note on the graph builder being one piece of code

There is a temptation to write one indexer per language. Do not. The builder is a single
language-agnostic engine; each language is a **declarative pack** it loads (patterns, resolution
rules, symbol extractors). Two consequences:

- Adding a language is a pack (data), not a new parser (code). The barrier to a new language is a
  pull request of rules, not an engine rewrite.
- Building PHP and TypeScript packs from day one is not politeness, it is the only way to keep the
  pack interface honestly language-agnostic. Ship one language first and the pack interface will
  silently absorb that language's assumptions (namespaces, one-class-per-file), and the second
  language will not fit. Two very different languages from the start force the abstraction to be
  real. This is the same reason you never validate an i18n framework with only English.
