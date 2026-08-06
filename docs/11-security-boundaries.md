# 11. Security boundaries

EmPo is a public repository, and it is a tool that runs inside private codebases. Whatever it reads
there is confidential and belongs to its owner. **None of it may ship in this repository.** This is
not a guideline, it is a release gate. A single leaked artifact can publish somebody's business
logic or an exploitable security detail to the open internet, where it is cached and indexed even
if later removed.

## The hard rule

The EmPo repository ships **only**:

- the engine (the language-agnostic graph builder),
- the language packs (rules over source, plus **synthetic** fixtures),
- the adapters (forge, tracker interfaces and their host translations),
- the review discipline (universal markdown),
- **synthetic** example artifacts under `examples/`.

The EmPo repository ships **none** of:

- a real `flows.json` from any private codebase,
- a real `spines/*.json` (these carry business logic and live security detail),
- a real `graph.json` or any generated index (it embeds a whole private dependency structure),
- real file paths, class names, route paths, table names, ticket keys, or `conventions.md` entries,
- any code copied from a private codebase.

## Why the spine is the sharpest risk

A spine names, on purpose, where a codebase is fragile and unasserted: which entry points go
unauthenticated, and the exact conditions under which a financial invariant can be made to break.
Publishing a real one is publishing an attack plan. Spines are the highest-value artifact in EmPo
and the one that must **never** appear with real content in a public repo. Every shipped spine
example is invented, for a fictional domain, and labeled as such.

This paragraph is itself subject to the rule it states. It describes the *category* of weakness a
spine records, and deliberately not any real instance of one. A document explaining why publishing
an attack plan is forbidden is a poor place to publish one.

## Synthetic examples only

`examples/` contains a fictional `acme-platform` (a made-up PHP+TS monorepo) with:

- an example `config.json` (real schema, fake paths),
- an example `flows.json` (fake flows over the fake tree),
- an example `spine.example.json` (a fictional order-total chain over that tree, invented
  invariants), beside the existing `empo.config.example.json`,
- a fixture corpus per pack (tiny synthetic source, enough to prove extraction).

These exist to document the schemas and to test the packs. They are the only project-shaped content
in the repo, and every value in them is fabricated.

## Design lineage is allowed, content is not

The docs may describe the shape of an idea that came out of working on closed source, in the
abstract: "this generalizes a money-path review skill from a Laravel codebase." That is lineage, and
it is fine. What they may not contain is the map's **content**: a real invariant, a real
`file:line`, a real vulnerable route, or an identifier that names whose codebase it was. The design
reasoning is legible; the private data is absent.

## Confidentiality obligations do not relax on a move

Where the work descends from tooling written under a codebase owner's explicit constraints, those
constraints travel with it. Moving a lesson into a public repository does not release the material
it was learned on. When in doubt about whether something is safe to publish, treat it as private and
ask. The cost of asking is a message; the cost of leaking is unrecoverable.

## A publish checklist

Run this before any commit that touches `examples/` or docs, and before any release:

1. Grep the whole tree for any real project's identifiers (a client or employer name, a ticket
   prefix, domain-specific class names, real routes). Zero hits required.
2. Confirm every file under `examples/` is the fictional `acme-platform`, not a renamed real tree.
3. Confirm no `generated/` artifact from any real codebase is tracked.
4. Confirm no spine contains a real security detail.
5. Confirm the docs carry design reasoning, not content.

Run it over what the repository **already holds**, not only over the diff. This checklist is cheap
and it is the last line of defense.
