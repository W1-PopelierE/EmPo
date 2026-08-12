# Conventions

The false-positive register. When a review flags something that a human judges to be correct as it
stands, the judgement belongs here, so the next review does not raise it again. `empo review`
counts the entries and tells the reviewer to read them before flagging anything.

It starts empty, because a convention nobody agreed to is worse than none: the register earns its
authority from having been written by this team, about this repository, one confirmed false
positive at a time.

Write one entry per convention. Open it with a second-level heading naming the rule, then a short
paragraph saying why the obvious finding is wrong here, with a coordinate an author can open: a
`file:line`, or a symbol they can grep for where a line number would go stale. A heading and a
bullet are both counted as entries, so keep the prose in paragraphs.

## A comment describing history is checked against branch history, not the net diff

A docstring here often explains why code is shaped as it is by naming what it replaced. The net
`main...branch` diff cannot see a thing that was added and then removed inside the same branch, so a
reviewer reading only the diff concludes the comment describes a repair that never happened. The
docstring on `matchesDeclaredPath` in `src/engine/flows.ts` is the standing example: it says
`engine/proposal.ts` had grown a private re-implementation of the prefix rule, and the net diff
shows no such removal, because the copy was added and consolidated away inside one branch. Run
`git log -p main..<branch> -- <file>` before flagging a comment as describing something that did not
happen.

The coordinate above is a symbol and not a `file:line`, which is the preamble's rule applied to this
file rather than a departure from it. A line number written here goes stale on the next edit to the
same file and sends the next reader to a blank line. Find it with
`grep -n "export function matchesDeclaredPath" src/engine/flows.ts` and read the block immediately
above the export.

## The php pack's `->notify(new …)` rule is anchored to no receiver, on purpose

Every other hazard dispatch rule in `src/packs/php/pack.json` names a facade or a `::dispatch`
spelling, so a reviewer reading the `notify` rule beside them concludes the missing receiver anchor
is an oversight and flags the over-report: a hand-rolled subject's `$subject->notify(new Event($x))`
written inside a transaction is reported as a queued handoff. That is a real over-report and it was
judged worth its cost. There is no receiver token to require, because `->notify()` is how Laravel
spells a notification on any notifiable; narrowing it would need the receiver's class, which no
call-site rule has, and dropping it loses `$user->notify(new OrderShipped)`, the commonest queue
path in Laravel that never says `dispatch`. The `new` bounds the damage, and the decision is pinned
in `test/schema/pack-hazards.test.ts` under "the accepted over-report".

The rule to apply: the queue rules anchored to `Mail::`, `Queue::` and `Notification::` are anchored
so a namespace-qualified lookalike is refused, and `->notify(` deliberately is not. Grep for
`the accepted over-report` before raising this again.
