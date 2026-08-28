# 00. Overview

## The problem, stated precisely

A modern application codebase has two properties that fight each other:

1. Its shared code (a price calculator, a core domain model, an auth guard, a serializer) is
   consumed by many flows that are otherwise unrelated. Pricing might be used by booking,
   wellness, ticketing, point-of-sale, signup, contract billing and lessons at once.
2. No single person, and no single agent context, holds the list of those consumers. The system
   requires omniscience and issues none.

The result is that every change to shared code is a blind change, and blind changes to shared
code are the single largest source of bugs. This is not a discipline problem that more care
fixes. The information needed to be careful is not in front of the person making the change.

An AI agent does not fix this. It makes it sharper. An agent is fluent, fast, and confident. It
will read one sibling method and conclude that the method next to it behaves the same way. It
will write "this change does not affect other flows" because the other flows are not in its
context, not because it checked. It will report a review finding that reads as authoritative and
is simply wrong, because it inferred the behavior of a called function from the function's name.

## The two principles

Everything in EmPo follows from two rules. If a feature does not serve one of these, it does not
belong in EmPo.

### Principle 1: Never guess the consumer list. Query it.

Impact ("if I change X, what can break") is answered from a generated dependency graph, not from
memory and not from a hand-written document. A hand-maintained coupling matrix rots within a
month. A generated one is true again the moment you regenerate it, and it records the commit it
was built against so staleness is visible rather than silent.

### Principle 2: An assertion is true only when something checked it.

"The code ran" is not evidence. "No exception was thrown" is not evidence. A review finding, an
impact claim, and a "this is now fixed" are all assertions, and each must be verified against the
real code before it reaches a human. In review this takes the shape of a verification funnel:
every suspected finding is dispatched to an independent check, and only survivors are written up.
A survivor also has to name the diff line that introduced it, because a defect the branch inherited
is not this author's and a review that reports it is reviewing the repository instead of the diff.
In impact analysis it takes the shape of "treat the flow list as a floor, not a ceiling, and grep
to confirm when a change smells wider than the graph says."

## What EmPo does, in one paragraph

EmPo builds a dependency graph of your repository without an LLM (deterministic, fast, seconds),
maps every file onto the end-user flows you care about, cross-references your test suite to learn
which of those flows actually assert on the values they produce, and exposes that as a query you
can run from a terminal. On top of that substrate it ships a review discipline: a workflow that
takes a pull request, grades it against its tracker ticket, finds impact the diff cannot show,
and refuses to surface any finding it did not verify or that the change did not introduce. For the
few chains in a codebase that carry irreversible consequences (money movement, auth, tenant
isolation), it maintains a hand-curated
"spine" of invariants that must still hold after a change, with drift detection so the spine
cannot quietly rot.

## Positioning: what already exists and why it is not this

| Tool | What it does | What it does not do |
|------|--------------|---------------------|
| madge, dependency-cruiser, deptrac, knip | Draw and lint the import graph | No flows, no test-coverage coupling, no review discipline, single-language |
| CodeRabbit, Copilot review, Diamond | LLM review of a diff | No generated impact substrate, so line-level only; no ticket-fit; findings unverified |
| OpenSpec, spec-kit | Spec / plan scaffolding for agents | No dependency reality at all; pure markdown |
| SonarQube, Semgrep | Static analysis / rules | Rule-based, not impact-and-flow aware; not agent-facing |

EmPo's unique claim is the **join**: dependency graph coupled to end-user flows coupled to test
coverage, feeding a review discipline that verifies before it asserts. Each half exists
somewhere. The combination, aimed at keeping an agent honest, does not.

## Why the discipline needs the substrate

The review workflow, the spine layer and the hooks would each be nothing more than a longer prompt
on their own, which is the reason the mechanical layer is built first and everything else is built
on top of it: **the discipline only works because verifiable ground truth sits underneath it.** A
review skill pointed at a strange codebase hallucinates exactly as much as the default. The
generated graph, the flow map, and the drift-checked spine are what make the agent's claims
checkable instead of confident.

## The shape of the product

Four layers, described fully in [01-architecture](01-architecture.md):

1. **Mechanical**: the CLI, deterministic, no LLM. Builds the graph, answers impact, checks
   drift, runs the commit gate. Must be useful to a human in a terminal with no agent attached.
2. **Semantic**: flows and spines. Proposed by an agent at init, owned and approved by a human.
3. **Discipline**: the review workflow and its rules. Shipped, project-independent, markdown.
4. **Adapters**: forge, tracker, and language packs. Configured per project. This is the layer
   that makes it run in someone else's repository at all.
