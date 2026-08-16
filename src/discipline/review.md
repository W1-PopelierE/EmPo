# Review discipline

This is the workflow `empo review` hands you after it prints the brief. The brief is facts: pull
request metadata, the ticket and its criteria, the diff, the blast radius of every changed file,
the blind flows it touches, the curated spines it lands on and what each says must still hold, the
tests that exist. This file is the procedure you run over them.

One rule governs all of it: an assertion is true only when something checked it. A review produces
suspected findings; a suspicion is not a finding until an independent check confirms it against the
source. Only survivors reach the author.

## Two invariants

**A review executes nothing.** No test run, no static analysis, no build, no running app, no
package install. CI ran the suite and the analyzer when the pull request was opened, so
reproducing that locally proves what is already proven and needs an environment you do not have.
Judging test coverage is a reading task, not a running task. This binds every check you dispatch,
not only you.

**A review disturbs nothing.** Because it executes nothing it needs only the branch's files, so it
reads a detached worktree with no environment setup. The author's checkout is untouched, and
several reviews run at once, including two of the same branch. The worktree is removed when the
review ends.

Both hold regardless of language, forge and tracker.

## The pipeline

```
0. ticket first         read the ticket BEFORE the diff, extract the acceptance criteria
1. fetch and isolate    PR metadata, pin the base branch, read inside the worktree
2. blast radius, spine  empo query every changed symbol and flow, then read the spine
3. siblings, absences   what should have changed too, what is missing that should be there
4. coverage by reading  name the test for each behavioural change, or state none exists
5. verify every suspect one independent check per suspect, in parallel, survivors only
6. ticket-fit grading   map each acceptance criterion to file:line evidence
7. produce the review   scope, resolution, findings, coverage, verdict, then tear down
```

## 0. Ticket first

Read the ticket, its description and every comment, before you open the diff. The order is the
point: reading the diff first anchors you on what is there and blinds you to what is missing, which
is how a pull request that is clean in isolation gets approved without solving the user's problem.

Write the acceptance criteria out as a numbered list before you continue. You grade against that
exact list in step 6, and a criterion you did not write down is one you will not check. Note
anything a comment defers or splits to a follow-up, so you do not later report as missing what the
author deliberately scoped out. If no tracker is configured the brief says so; see "When an adapter
is missing" at the end.

## 1. Fetch and isolate

The brief carries the pull request metadata: title, author, source branch, base branch,
description, URL. Two fields are load-bearing.

**Base branch.** It is often not the default branch. Stacked pull requests are common, and
comparing against the wrong base floods the review with findings that belong to the parent. Use the
base from the brief everywhere downstream, including any automated pass, and call it out in the
report when it is not the default.

**Source branch.** Already checked out verbatim into a detached worktree, whose path the brief
gives you. Every read and grep for the rest of this review happens inside that path, never in the
author's checkout, which sits on a different commit and will silently answer the wrong question. Do
not install, build or configure anything there.

## 2. Blast radius and spine

Run `empo query <symbol>` for every changed file and every changed symbol, by path
(`empo query apps/api/app/Libraries/Price/PriceCalculator.php`) or by short name
(`empo query PriceCalculator`). Never assemble the consumer list by grepping around and guessing at
it; that is what the graph is for.

From each answer, carry forward: fan-in, every flow the change can reach, which of those flows are
blind, the top consumers with their `file:line` evidence, and any symbol join (a change in
`apps/api` that an `apps/mobile` screen consumes through a bridge edge, or a command a scheduler
entry names). Report every flow the
change reaches, not only the one the ticket talks about, and name the blind flows explicitly,
because a wrong result ships silently there.

**How often does this run, and did that just change?** Two facts in the brief answer the first half
and nothing answers the second, so it is yours to ask. A `join scheduled-command` row means the
changed file is reached from a scheduler entry, and the citation is the scheduled line itself, where
the cadence is written; open it and read the cadence, because the graph does not carry it. The
`dispatches inside a loop` section names every dispatch a changed file makes per iteration, the job
it lands on as a file you can open, and any other scheduler entry that feeds that same job. Open the
handler: what it does with a failure is written there and never at the dispatch. If a second entry
feeds the queue on a timer, ask what happens to the work this one dispatches when it fails, because
a queue filled from two directions is where a volume change stops being a volume change.

Neither is a finding, and neither is evidence of one. What they are is the place to ask what bounds
the loop: how many rows does the query above it return, and did this diff widen it. A dispatch in a
loop is how a batch is written, and it becomes a defect only against a cardinality that lives in the
data and not in the source, which is why empo states the coordinate and stops. If you conclude the
volume changed, that is a finding like any other and it goes through the gate with a citation.

Treat the flow list as a floor, not a ceiling. Absence of evidence is not evidence of absence: the
graph records the edges it can see, and reflection, dynamic dispatch and configuration-driven
wiring are invisible to it. When a change smells wider than the graph says, grep the worktree to
confirm, and say which part of the radius came from the graph and which from your own search.

**The spine says what must still hold.** Under `spines touched` the brief prints, of the spines this
repository curates, the ones this change lands on, with their file path. The graph is generated and
cannot see an invariant; the spine is curated and says what has to still be true once the change
arrives, which is a statement about what nothing checks, and absence is precisely what a generated
graph cannot hold. Read that section before you read another line of the diff: a hop marked
`CHANGED BY THIS DIFF` is where the change is standing on the chain, and everything below it is
downstream of what the change did.

Two parts of it are filtered to this change rather than printed in full: the `guarded` paths are the
guarded paths the diff touches, and the flows are the spine's flows the blast radius reaches. Hops,
invariants and traps are the whole spine. When you need what was filtered out, open the spine file
at the path beside its name; it is JSON, and reading it is a read like any other.

Carry each part forward to the step that uses it:

- The `principle` line and the hops, as the map you locate the change on. Cite the hop by number in
  the report ("hop 2 of the pricing spine") so the author reads the change where the spine puts it.
- Every `guarded` path the diff touches, and under them the one line naming what `empo check` wants
  an added test line to use. Those are this spine's assertion terms, and they are step 4's bar, not
  this step's.
- Every flow the brief marks `UNGUARDED`, the spine's human-confirmed blind flow: a wrong value
  reaches an end user there with nothing asserting otherwise. Name those flows in the report.
- Every invariant, and hardest the ones marked `PROSE ONLY`, because nothing executes them and your
  reading is the only thing between the diff and a broken one. For each, say whether the diff still
  satisfies it, with the `file:line` you read to decide.
- Every `trap`, which goes to step 5 as a place to go and look, not as a suspect.

A spine invariant this diff breaks is an `impact` finding, cited at the diff line that breaks it and
naming the invariant. A guarded change the tests leave unasserted is a `coverage` finding. There is
no spine `kind`: a spine tells you where to look and how hard, it does not add a category.

**A drifted coordinate is a fact about the map, not by itself a finding about the pull request.**
The brief labels each one where it prints it, and the two labels mean different things. A
coordinate reading `(the spine says :13; the anchor moved, empo verify has the rest)` is printed at
the line the anchored text is really on: open that line, quote it, use it. Only the spine's stored
number is stale. `ANCHOR NOWHERE` means the text is not in that file at all, so the coordinate is
fiction: never quote it, never rest a finding on it, and re-establish from real source whatever
claim it was carrying before you use that claim at all.

Then ask, for either label, what moved. If this diff moved or deleted the anchored line, the spine
went stale because of this pull request, and repairing it belongs in this pull request: report it,
cite the hunk that did it, and say which spine file and which coordinate to correct. If the diff
does not touch that file, the map rotted earlier and elsewhere, so give it one maintenance line and
do not spend a finding on an author who did not cause it. Drift is a defect in the pull request only
when the pull request caused it.

## 3. Siblings and absences

Two different searches, and the second one is the one the graph cannot do for you.

**Siblings: changes that should have propagated.** A method added to `Order` that `Subscription`
needs too. A translation key added to one locale file and not its neighbour. A form field with no
matching validation rule, column, factory or seeder. A new route with no policy and no menu entry.
A new field in an `apps/api` response that the `apps/mobile` type parsing it does not declare.

**Absences: a flow you expected in the blast radius and did not find.** Ask which is true: that
flow genuinely does not need this code, or that flow duplicated the logic instead of importing it.
Duplication is invisible to a dependency graph and is exactly where the bug you are looking for
lives. Grep every root for the distinctive part, a constant, a formula, a literal string, a column
name, and read what you find.

A spine turns that search from open-ended into precise. Its hops are the chain everything is
supposed to funnel through, so take the distinctive text at the changed hop and grep every root for
it: a flow that reimplements a hop instead of importing it is the sharpest form of this absence, it
will not appear in any blast radius, and the spine is the only artifact that says the funnel was
meant to be one. What you find there is an `impact` finding, and it is also a fact the spine does
not yet know.

## 4. Coverage, by reading

For each behavioural change in the diff, name the test that exercises it with a `file:line`, or
state plainly that none exists. Read the tests. Do not run them.

- A bug-fix ticket with no regression test that reproduces the original bug is a finding.
- A new public entry point with no test is a finding.
- A test that asserts only a status code for a change that alters data is weak coverage. Say so,
  and say which value goes unasserted.
- **On a spine, the bar is that spine's own assertion terms, narrower than the language default.** A
  value on a curated chain is not correct because the code ran; it is correct because a test
  asserted it, in the smallest exact unit the spine names (cents, not floats). A test that
  exercises the chain without asserting a value in those terms does not cover this change, whatever
  else it covers. The brief prints the terms under a guarded path the diff touches; when it printed
  none, read `assertionTerms` in the spine file the brief named. The commit gate sees only that a
  line using one of those terms was added, never that it asserts the right value, so read the test
  and say which value it pins and which it leaves open. A guarded file changed with no such
  assertion is a `coverage` finding.
- **Modified tests deserve the hardest look.** Read the old side and the new side of every test
  hunk and ask whether an assertion was loosened, narrowed or deleted to make the new code pass. CI
  can never catch that, a reading review can, and it is the highest-value thing in this step.

## 5. Verify every suspect

This is the heart of the discipline. A wrong finding wastes the author's time and burns the trust
that makes the next review worth reading, so nothing is flagged on assumption, only on verified
behaviour.

**Collect the suspects.** One line per suspected finding, from your own pass in steps 2 to 4 and
from any automated pass the brief includes. Dedupe first: a line-level automated reviewer and your
own reading land on the same line more often than not. An automated reviewer's "Critical" carries
no more weight than your own hunch until a check confirms it, and every source funnels through the
same gate.

**Check the register first.** Read `.empo/conventions.md` and drop any suspect it already explains.

**Then walk the spine's traps.** A trap is a second register of the opposite kind, and merging the
two loses both: the conventions register says what not to flag, so it removes suspects; a trap says
what to go and look at, so it adds them. A trap is already verified and already carries its
`file:line`, so it is not itself a suspect to check. What is a suspect is whether this diff walks
into it, and that goes through the funnel like anything else.

**Dispatch one independent check per suspect, in parallel.** A check is self-contained: it does not
see your reasoning and must not need to. Each one states the claim, names the read root, names the
exact files and symbols to open and the exact greps to run, and demands a fixed verdict:

```
CLAIM   PriceCalculator::total() subtracts the discount from the gross amount, so a line
        that already carries tax is discounted twice.
ROOT    <the worktree path from the brief>
READ    apps/api/app/Libraries/Price/PriceCalculator.php, the whole body of total()
        apps/api/app/Models/Order.php, every call site of total()
GREP    "->total(" across apps/api, "total(" across apps/mobile
ANSWER  VERIFIED, FALSE POSITIVE or UNCLEAR, with a file:line and the exact source line
        you read it from. Read and grep only. Do not run tests, analysis or the app.
```

**Keep only the survivors.**

- VERIFIED goes into the review, with the evidence the check returned.
- FALSE POSITIVE is dropped, and appended to the register if it is a trap the codebase will set
  again.
- UNCLEAR is either sharpened with a follow-up check that names what was missing, or downgraded to
  an open question for the author with severity `question`. UNCLEAR is never written as a defect.

### Forbidden phrasings

Each of these is a signal that you are guessing rather than reporting. They govern findings, not
the checks you write. If one appears in a finding, apply the remedy or drop the finding.

- "If X ever calls, fires, or is reached" -> read X. Either it does, and the finding is about what
  it actually does, or it does not, and there is no finding.
- "This may break", "might break", "could break" -> grep the callers and read them. Name the caller
  and the line, or drop it. A finding names a break that is present, not one that could be.
- "Likely", "probably", "presumably", "possibly", "I assume", "I believe", "seems to", "appears to"
  -> not allowed in a finding. If you cannot state it flatly, you have not checked it yet.
- "Anyone with access could" -> trace the actual middleware, policy and guard chain, and cite the
  `file:line` where the chain lets the request through.
- "X never saves", "does not persist", "fails to validate", "returns null", "does not fire the
  event" -> any claim about what a *called* function does or omits internally requires reading that
  function's body first. Never infer a callee's behaviour from its name, from its caller, or from a
  sibling: a sibling may take a `save` flag while this one saves unconditionally. Open the callee
  and cite the line where the side effect is present or absent, or drop the finding.

The CLI enforces this mechanically: the submission gate lints the title and claim of every finding
and drops the ones that hedge, so a hedged finding never reaches the author. The last rule is
enforced by the citation gate instead, because no lint can tell whether you read the callee and
only a real anchor in the callee's file can. This is a gate, not advice. Write each finding as a
statement of fact with a citation behind it.

### The false-positive register

Codebases have conventions that make correct code look broken from a diff: a framework that writes
through property setters, so a narrow allow-list proves nothing about what is writable; a base
class that supplies a scope the model does not show. `.empo/conventions.md` is the register of
those traps. Read it before flagging anything, and append every confirmed false positive as one
entry: the shape of the mistake, and the rule that makes it a non-issue.

```
- Models under apps/api/app/Models write through property setters, so a narrow fillable
  list does not prove a field is unwritable. Read the setter before flagging this.
```

The register starts empty and grows one entry at a time, which is what makes the tool better the
longer a team uses it. An entry skipped is value thrown away.

## 6. Ticket-fit grading

Take the numbered criteria from step 0. For each one, point at the `file:line` or the test that
satisfies it and mark it `resolved`, `partial` or `missing`. A criterion with no citation is not
resolved, however obviously the diff appears to address it. Honour the ticket comments: do not
report as missing what a comment deferred or split off, but do say that it was deferred and where.

Where the brief says the comments were **not fetched**, that instruction has nothing behind it and
you must not read the silence as evidence. A deferral you could not see is not a deferral that did
not happen, so grade the criteria on the ticket body alone and say in the ticket-fit section that
the comments were unread. A brief that says the ticket carries none has answered the question; a
brief that says nobody looked has not.

Close with one overall status: Fully resolved, Partially resolved, Not resolved, or Out-of-scope
mismatch, the last meaning the diff does something other than what the ticket asked for. A pull
request that is partial or not resolved is not approved without explicit confirmation from the
author that the gap is intentional.

## 7. Produce the review

One report, in this order:

- **Scope**: one line on what the pull request does.
- **Ticket**: key, title, type, permalink, and a one-line restatement of the criteria.
- **Base branch**: stated explicitly when not the default, since it changes what "the diff" means.
- **Spine**: the spine this change lands on, the hop it touches, and each invariant marked as still
  holding or broken. One line saying no spine claims this change when none does, and one line
  saying the repository curates none when it curates none.
- **Ticket resolution**: each criterion with its evidence and its mark, then the overall status.
- **Diff-level findings**: issues visible in the diff, each with a `file:line`.
- **Impact findings**: breakages in files the diff does not touch, found through the blast radius,
  each with a `file:line`. Name the flow that breaks.
- **Coverage**: which behavioural changes have a test, which do not, and whether any assertion was
  weakened. Never write that tests pass or fail. The review did not run them, CI did. Point at the
  CI result if it matters.
- **Verdict**: approve, request changes, or needs discussion.

When the review learned something a spine does not know, a trap nobody had written down, a flow
that duplicates a hop, a test that turns out to assert nothing, a coordinate this diff moved, write
it as the concrete edit to make: the spine file, the field, and the anchor to add or correct. That
edit belongs in this pull request, because a finding left only in a report is a finding the team
pays to rediscover, and the spine is the one artifact here that compounds.

Every path in the report is repo-relative: the author reads it in their own checkout, where a path
into the review's scratch worktree means nothing. Then tear down, as the last action of the review
and also when it ends early or fails: remove the worktree. The author's checkout was never touched.

## Submitting the findings

Write the findings you intend to report to a JSON file, then hand it to the gate with
`empo review --findings <path>`:

```json
{
  "findings": [
    {
      "id": "F1",
      "kind": "diff",
      "severity": "major",
      "title": "Discount is applied before tax, reversing the documented order",
      "claim": "PriceCalculator::total() subtracts the discount from the gross amount, so a taxed line is discounted twice.",
      "citation": { "file": "apps/api/app/Libraries/Price/PriceCalculator.php", "line": 42, "anchor": "$total = $gross - $discount;" },
      "supporting": [{ "file": "apps/api/app/Models/Order.php", "line": 12, "anchor": "public function total(): int" }],
      "suggestion": "Apply the discount to the net amount, after tax."
    }
  ]
}
```

The fields:

- `kind` is `diff` for something visible in the diff, `impact` for a breakage in a file the diff
  does not touch, found through the blast radius, or `coverage` for a missing or weakened test.
- `severity` is `blocker`, `major`, `minor` or `question`, the last being where a downgraded
  UNCLEAR goes. `title` is the one-line summary the author reads first, `claim` the verified
  statement, in the declarative, with no hedging.
- `citation` is the single line the finding rests on. `anchor` is the exact source text at that
  line, copied from the file, not retyped from memory and not reformatted: the gate drops any
  finding whose anchor is not present in the cited file. A citation nobody checked is the failure
  this whole tool exists to prevent, so every one is checked.
- `supporting` is optional, for the other lines that back the claim up, same anchor rule.
  `suggestion` is optional too; leave it out rather than guess at a fix.
- Every path is repo-relative, never worktree-absolute, because the author reads it in their own
  checkout.

## When an adapter is missing

Configuration degrades, it never blocks the review.

- **No forge.** There is no pull request to fetch, so the review runs on the local diff against the
  base branch. State in the report which base was used.
- **No tracker.** Step 6 is skipped and the report says so in one line: ticket-fit was not checked
  because no tracker is configured. Do not guess at criteria from the pull request title.
- **Neither.** The review is a local diff, impact and coverage review, and it still runs the whole
  verification funnel in step 5. The funnel is the review; adapters only decide how much context
  it has.
- **No spine.** Most repositories curate none, and a change can touch none of the ones that exist.
  The brief says which of the two it is, and the report repeats it in one line. Nothing else in
  step 2 changes: the blast radius, the absences in step 3 and the reading in step 4 are what a
  spine sharpens, never what it replaces.

A step that is skipped is reported as skipped. It is never dropped in silence, because a report
that omits a step reads exactly like a report that passed it.
