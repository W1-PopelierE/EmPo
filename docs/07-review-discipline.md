# 07. Review discipline

This is layer 3: the shipped, project-independent workflow that turns EmPo from a graph tool into
a reviewer that keeps an agent honest. It generalizes a PR-review skill written for one product,
with every product-specific detail (one forge, one tracker, one ticket-key format) pushed out to
adapters. The discipline itself is universal.

The whole discipline serves principle 2: **an assertion is true only when something checked it.**
A review produces suspected findings; suspicions are not findings until verified; only survivors
reach the author.

## Three invariants that govern every review

1. **A review executes nothing.** No test run, no static analysis, no build, no running app. CI
   already runs the suite and the analyzer when the PR is created. The review reads, traces, and
   judges. Judging test coverage is a reading task, not a running task. Reproducing CI locally
   proves what CI already proved, costs minutes, and needs an environment the review does not have.
2. **A review disturbs nothing and can run in parallel.** Because it executes nothing, it only
   needs the branch's files. Get them with a detached worktree and no environment setup, so the
   human's checkout is untouched and several reviews can run at once. Remove the worktree when done.
3. **A review reports only what this pull request introduced or broke.** A defect the branch
   inherited is real, is sometimes worse than anything in the diff, and is not this author's to fix.
   A review that reports it anyway never converges, because the backlog it is really reviewing is
   the whole repository. So every finding names the diff line that caused it, and a finding that
   cannot is dropped rather than reported. This is not a severity judgement: an inherited blocker is
   still dropped, and goes to the maintenance line of step 7 instead of into the findings.

All three are enforced regardless of language or forge.

## The pipeline

```text
0. ticket first          find the tracker ticket BEFORE reading the diff, extract acceptance criteria
1. fetch + isolate       PR metadata via forge adapter; branch into a detached worktree
2. blast radius          empo query every changed symbol; name every flow and every spine it touches
3. siblings + absences   what should have changed too; what flow is missing that should be present
4. coverage (reading)    for each behavioural change, name the test or state none exists
5. VERIFY every suspect  one independent check per suspect, in parallel; survivors only
6. ticket-fit grading    map each acceptance criterion to file:line evidence
7. produce the review    scope, ticket resolution, findings, coverage, verdict
8. teardown              remove the worktree
```

### 0. Ticket first (why order matters)

Read the ticket before the diff. Reading the diff first anchors you on what is there and makes you
blind to what is missing. The forge adapter extracts the ticket key from the branch, PR title, or
PR body using the config `keyPattern`; the tracker adapter loads the ticket. Capture the acceptance
criteria now; you grade against them in step 6. Skipping this is the most common way to approve a
PR that is clean in isolation but does not solve the user's problem.

### 1. Fetch and isolate

The forge adapter (see [09-adapters](09-adapters.md)) returns PR metadata in one call: title,
author, source branch, base branch, description, URL. Two things to capture:

- **Base branch.** Often not the default branch. Stacked PRs are common, and comparing against the
  wrong base floods the review with findings that belong to the parent PR. Pin the base explicitly
  everywhere downstream (`empo review --base`, and any automated pass).
- **Source branch**, checked out verbatim into a detached worktree with no environment setup.

### 2. Blast radius

Every grep and read happens inside the worktree, not the human's checkout. For each changed symbol
run `empo query` and state, in the review, every flow the change can reach. Not just the flow named
in the ticket. Call out blind flows (no value-asserting test) explicitly, because a wrong result
ships silently there. This is the step that only EmPo can do, because it stands on the graph.

The brief prints the spines this change is on directly under the flows, and they are the other half
of this step. The graph says what a change reaches; a spine says what must still be true once it gets
there, which is a claim about invariants and about absence, and absence is what a generated graph
cannot hold ([08-spines](08-spines.md)). It is curated knowledge filling exactly the blind spot step
3 sends you hunting for by hand: the trap somebody already fell into, the invariant nothing asserts,
the flow this repository has already recorded as unguarded. Read the section before the diff, the way
you read the ticket. [01-architecture](01-architecture.md) has always drawn this layer as reading the
graph, the flows *and* the spines; until the brief named them, only the first two were ever in front
of the reviewer.

A spine surfaces for three reasons and the brief keeps them apart, because they ask for different
work. A changed file that a `guarded` glob claims is exactly what `empo check` will fail a commit on,
so treat it as a gate that has already spoken. A changed file that a hop or a trap cites is the map
the author should have read first, and it is the commonest of the three, since `guarded` is curated
to be gateable while a chain runs through files nobody wants gated. A flow overlap is the spine's own
claim meeting the graph's. The review is deliberately wider than the gate: a gate may only fail on a
rule its author wrote down, and a human can weigh a signal that is merely worth reading.

Every coordinate in the section carries its own drift verdict, resolved against the code under
review, which on a pull request is not the revision the spine was curated on ([06-cli](06-cli.md)):
the map is the team's and the code is the change's. An anchor that moved is printed at the
line it is really on. An anchor that is nowhere is labelled and is not a coordinate at all: cite
`empo verify` and the repair, never that line. A drifted spine is still worth reading, because what
rotted is a number and not the claim.

### 3. Siblings and absences

Two different searches:

- **Siblings**: changes that should propagate. A method added to one model that its sibling needs
  too; a translation key added in one locale but not another; a form field with no matching
  validation, column, factory, or seeder; a new route with no policy or menu entry.
- **Absences (the dangerous one)**: a flow you expected in the blast radius and did not see. Ask
  whether it does not need this code, or whether it **duplicated** the logic instead of importing
  it. Duplication is invisible to a dependency graph and is exactly where bugs hide. The graph
  cannot find this; the reviewer must, by hand.

### 4. Coverage, by reading

For each behavioural change, name the test that exercises it (`file:line`) or state that none
exists. A bug-fix ticket with no regression test reproducing the original bug is a finding. New
public entry points with no test are a finding. A test that asserts only a 200 for a change that
alters data is weak coverage; say so. **Modified tests deserve the hardest look: was an assertion
loosened or deleted to make the new code pass?** CI can never catch that; a reading review can, and
it is the highest-value thing here.

### 5. Verify every suspect (the heart of it)

A wrong finding wastes the author's time and burns trust. Nothing is flagged on assumption, only on
verified behavior.

1. **Collect suspects into a checklist.** One item per suspected finding, from your manual pass and
   from any automated pass (an integrated line-level reviewer, if configured). Dedupe first; the
   automated and manual passes often land on the same line.
2. **Dispatch one independent check per suspect, in parallel.** Each check reads and greps; it does
   **not** run tests, analysis, or the app (same rule as invariant 1). Each check is self-contained:
   it states the claim, gives the worktree path as the read root, names the exact files/symbols and
   greps, and must return **VERIFIED / FALSE POSITIVE / UNCLEAR** with `file:line` evidence.
3. **Keep only survivors.** VERIFIED goes into the review with its evidence. FALSE POSITIVE is
   dropped, and if it is a recurring trap it is added to `conventions.md`. UNCLEAR is either
   sharpened with a follow-up check or downgraded to an open question for the author, never written
   as a defect.

An automated reviewer's "Critical" carries no more weight than your own hunch until a check
confirms it. Every source of suspects funnels through the same verification. This is where
false positives die.

#### Every finding names the line that introduced it

A survivor carries a second citation beside the one it stands on. `introducedBy` is the same shape
as `citation` — file, line, anchor — and it names the diff line that introduced or broke the
finding. It is required, not optional: a finding the pull request did not cause is not this pull
request's finding (invariant 3), and making the field optional makes the invariant advice.

For a `diff` finding it is usually the citation itself, since the defect is on the changed line. For
an `impact` or a `coverage` finding the two citations are in different files by construction: the
claim rests on the file that breaks or on the test that is missing, and `introducedBy` is the hunk
whose change reaches that far. That pair is what makes an impact finding answerable — the author
reads a file this pull request never opened, and the first question they ask is what in the diff
made it theirs.

Deriving the field is a reading task like the rest of step 5, and it is asked of every survivor:
name the hunk, the line the author added, changed or deleted that made this true. If there is no
such line the code was already like that before the branch, and it goes to the maintenance line of
step 7 rather than into the findings.

#### Forbidden phrasings (red flags that you are guessing)

If any of these appears in a **finding** (not in a verification prompt), stop and verify or drop it:

- "If X ever calls / fires / is reached…" -> read X.
- "This may break…" -> grep the callers and read them.
- "Likely / probably / presumably / I assume…" -> not allowed in a finding.
- "Anyone with access could…" -> trace the actual middleware/policy/guard chain.
- "X never saves / does not persist / fails to validate / returns null / does not fire the event…"
  -> any claim about what a **called** function does or omits internally requires reading that
  function's body first. Never infer a callee's behavior from its name, its caller, or a sibling
  (a sibling may take a `save` flag while this one saves unconditionally). Open the callee, cite the
  line where the side-effect is present or absent, or drop the finding.

The CLI enforces this funnel mechanically rather than trusting it to be followed. `empo review`
prints the executable form of this doc, `src/discipline/review.md`, then gates the findings that
come back, in this order: each citation anchor is resolved against the real source in the worktree
and the finding is dropped if the anchor is not there; the `introducedBy` anchor is resolved the
same way and the finding is dropped as `not-introduced` if it is nowhere, or if the line it is
really on lies outside every hunk of this pull request's diff; and the title and claim of every
finding are linted against the phrasings above. The citation is checked first because it is the
ground truth, and a fabricated finding is worth reporting as fabricated rather than as inherited.
Only survivors are printed. The last phrasing rule is deliberately not in the lint,
because "does not persist" is exactly what a finding says *after* the callee has been read and no
regex can tell whether it was; banning the wording would delete true findings. The citation gate
enforces that one instead, since the claim only ships if it quotes a real line of the callee.

The changed-line half of that needs the diff phase 1 saved, and phase 2 reads it back. If the file
is gone the containment check alone is skipped and the report says so in a note, because a gate that
quietly stops checking reads exactly like one that checked and found nothing wrong. The
`introducedBy` anchor is still resolved against source in that case: a citation nobody checked is
the failure this gate exists to prevent whether or not a diff is at hand.

#### The false-positive register (`conventions.md`)

Codebases have conventions that make correct code look buggy from a diff (a framework that writes
through property setters so a narrow allow-list is irrelevant; a base class that supplies a scope
the model does not show). Each confirmed false positive is appended to `.empo/conventions.md` with
the rule that makes it a non-issue. The register starts empty and grows per review, which is what
makes EmPo better the longer a team uses it. Before flagging, check the register.

### 6. Ticket-fit grading

For each acceptance criterion, point to the `file:line` or test that satisfies it, and mark it
resolved / partial / missing. Read the ticket comments too: the author may have deferred a sub-item
or split it to another PR, so do not flag as missing what a comment scoped out. Conclude with a
single status: Fully resolved / Partially resolved / Not resolved / Out-of-scope mismatch. A PR
that is partial or not resolved should not be approved without explicit author confirmation the gap
is intentional.

### 7. Produce the review

One report, structured:

- **Scope**: one line on what the PR does.
- **Ticket**: key, title, type, permalink, one-line restatement of the criteria.
- **Base branch**: called out explicitly when not the default (stacked PR), since it changes what
  "the diff" even means.
- **Ticket resolution**: each criterion mapped to evidence, marked resolved/partial/missing, with
  an overall status.
- **Diff-level findings**: issues visible in the diff (`file:line`).
- **Impact findings**: breakages in files not in the diff (`file:line`), from the blast radius.
- **Spine**: the curated chains this change is on, what each one says must still hold, and any
  invariant behind which nothing asserts. A finding that comes out of a spine is still a diff,
  impact or coverage finding and is reported as one; the spine is where it came from, not a fourth
  kind. Report a drifted coordinate as drift and never cite it as evidence, because a citation that
  does not resolve is the one thing this workflow exists to keep out of a report.
- **Coverage**: which behavioural changes have a test, which do not, whether any assertion was
  weakened. Never claim tests pass or fail; the review did not run them, CI did. Point at the CI
  result if it matters.
- **Maintenance**: one line for a real defect the branch inherited, where the review found one. No
  severity, no citation ceremony, and never mixed in with the findings: it is a fact about the
  repository, offered, and not a change asked of this author. Dropping it on the floor would waste
  what the review already learned; ranking it beside the findings is how a review stops converging.
- **Verdict**: approve / request changes / needs discussion.

Every finding, whatever its kind, prints `introduced by file:line` under its claim, and an `impact`
or `coverage` comment posted to the pull request names it in a sentence of its own. A `diff` comment
does not, because it lands on the changed line and would be pointing at itself. The author of an
impact finding is being asked about a file this pull request never opened, so the line that made it
theirs is part of the finding and not something they should have to reconstruct.

Every `file:line` in the report is **repo-relative**, not worktree-absolute. The author reads it in
their own checkout; a path into the review's scratch worktree is useless to them.

### 8. Teardown

Remove the worktree. The human's checkout was never touched.

## What is universal here versus what an adapter supplies

| Universal (this doc) | Adapter-supplied |
|----------------------|------------------|
| The eight-step pipeline | How to fetch a PR (forge) |
| Reporting only what the diff introduced, `introducedBy` on every finding | Which hunks the diff has (forge, base branch) |
| The verification funnel and forbidden phrasings | How to read a ticket (tracker) |
| Ticket-fit grading as a concept | The ticket-key pattern (`keyPattern`) |
| Coverage-by-reading, never running | The language's assertion terms (pack) |
| Reading the spine before the diff, and the three reasons one surfaces | The spines themselves, and what they guard (project's `.empo/spines/`) |
| The false-positive register mechanism | The specific entries (project's `conventions.md`) |
| Repo-relative citations, worktree isolation | The worktree path convention (host) |

Posting findings to a PR, writing customer-facing release notes, the exact comment formatting: those
are outward-facing and adapter- and team-specific, and default to off. They live in
[09-adapters](09-adapters.md), not here, because the discipline of reviewing is separate from the
etiquette of publishing.
