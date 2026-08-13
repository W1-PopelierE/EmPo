# 09. Adapters

Adapters are what let the same review run against different hosts and trackers without touching the
discipline. There are two adapter kinds, forge and tracker, plus a note on the publishing etiquette
that adapters carry. Language packs are also technically adapters but are large enough to have their
own doc ([04-language-packs](04-language-packs.md)).

An adapter is a thin, uniform interface. The review discipline ([07-review-discipline](07-review-discipline.md))
calls the interface; the adapter translates to the host's CLI, or to a JSON payload the agent running
EmPo fetched on its behalf. Adding a host is implementing the interface, not editing the discipline.

## Forge adapter

Abstracts the pull-request host. The interface the discipline depends on:

| Capability | What it returns / does | Notes |
|------------|------------------------|-------|
| `getPr(id)` | title, author, source branch, base branch, description, URL, in one call | base branch is load-bearing for stacked PRs |
| `getDiff(id)` | the unified diff as text | written to a PR-scoped scratch file `pr-<id>.diff`, never a shared name (see below for where) |
| `listComments(id)` | existing review comments | so the review does not duplicate them |
| `getCiResult(id)` | pass/fail of the pipeline | the review reads this instead of running tests |
| `approve` / `requestChanges` | verdict actions | mutating; on the interface, called by nothing in this version |
| `comment(id, body, [inline])` | post a finding | mutating; off by default, `--post` opts in |

`--readonly` is worth a correction this table used to carry the wrong version of. It does not suppress
a set of actions. The only thing it does in this version is refuse to run alongside `--post`, because
the two flags contradict each other and a pair that quietly picks a winner is worse than one that
stops and says so. Nothing else reads it, and nothing else needs to, because the verdict actions have
no caller to suppress: `approve` and `requestChanges` are declared on the interface and implemented by
every adapter, but an EmPo review reaches its verdict in the brief rather than in the pull request's
approval state, so the shipped code never calls either one.

An adapter declares which of these it has rather than being assumed to have all of them, as a
capability set (`pr`, `diff`, `comments`, `ci`, `post`). `local` declares `diff` and nothing else,
so the review says CI was not consulted instead of inventing a green pipeline, and the brief names
the set it was working with. Only `diff` is universal: it is what makes `local` a real adapter rather
than a stub.

**Which sentence it says about CI depends on what it is standing in for**, and that is not a detail.
`createForge` reaches the local adapter from five places: one covers both "nobody configured a forge"
and a forge configured `local`, three have a `github` or `mcp` forge in config that this run could
not consult, and the last is a kind no version can build. Only the first half of the first is "no
forge is configured", and for a long time every one of them printed
`no forge is configured, so CI was not consulted`, which sent a reader to write a config file they
already had. So the adapter is told what it stands in for, and four cases print apart:

- no forge configured at all,
- a forge configured `local`, which **contacts** no host (the sentence is about what the adapter
  does, not about the `host` key, because `forgeSchema` puts `host` on every kind and
  `{ "kind": "local", "host": "bitbucket" }` parses),
- no pull request named, so there is no CI run that could have been read,
- a configured host this run did not reach, which names it.

The third and fourth are the pair worth not collapsing, and the third is the one that fires most
often, because a review with no argument is a review of the working diff. Telling its reader that CI
"was not read" reports a pipeline that existed and went unlooked-at, and sends an agent to find
something that is not there. The split follows the rule `empo doctor` uses for `kind: null` against
`kind: "local"`: a silence and a statement are different facts. *Why* a host went unread stays the
degradation note's job below, because one fact worded in two places is two wordings that drift.

### Forge adapters

| `kind` | Transport | In this version | Notes |
|--------|-----------|-----------------|-------|
| `github` | `gh` CLI | shipped | `gh pr view/diff/review`. The reference implementation. |
| `mcp` | a JSON payload the agent host fetched | shipped | Bitbucket, GitLab, and whatever comes next. EmPo states what it needs, the agent fetches it, EmPo checks the answer against git. `adapters.forge.host` names the system for the reader. |
| `local` | `git` | shipped | no host; diff the working tree against `--base`. The zero-config fallback. |

`github` speaks through the `gh` CLI so EmPo never holds a token and never talks to an API it would
have to version, and every subprocess goes through the one `run` in `engine/git.ts`, so there is a
single file to audit for what this tool executes. What a failure costs decides whether it throws: the
pull request, the diff and any post the human asked for fail loudly, while comments and CI degrade to
"unknown", because the contract has a way to say "not checked" and the review is required to use it.

`mcp` keeps both of those properties without a second CLI to shell out to, which is the next section.

## The `mcp` kind: the agent fetches, EmPo gates

**This doc used to claim something that cannot be true.** The forge table above listed a `bitbucket`
kind whose transport was "Atlassian Rovo MCP", and the tracker table listed `jira`, `asana` and
`linear` the same way. EmPo makes no model call anywhere and holds no token. MCP is not a protocol a
CLI dials on its own: it is driven by the agent host, whose connectors authenticate interactively
against a session the CLI is not part of. So an adapter inside this CLI that "speaks Rovo MCP" has no
way to speak anything. Those four rows were a plan for a transport that does not exist at this layer.

The fifth removed row, `gitlab` through the `glab` CLI, is a different case and is worth keeping
distinct: that one was buildable exactly as written. It went because `mcp` already covers it for no
code, and shipping a second `gh`-shaped adapter would have meant a second CLI to require, detect and
degrade from, for a host the one mechanism already reaches.

This is the same category of correction as the host wiring shipping as generated `.claude/`
configuration rather than as a plugin ([10-distribution](10-distribution.md)): a mechanism was named
in a doc before anyone checked whether it could fire in the situation the product actually runs in.

What replaced it is one `mcp` kind on each adapter, and the inversion that makes it work: **the agent
fetches, EmPo gates.** The agent running `empo review` is the one holding the connectors. So EmPo
prints exactly what it needs and the shape it needs it in, the agent fetches it with whatever tool it
has, writes JSON to a path EmPo named, and re-runs the command pointing at that file. EmPo then
validates the file and checks it against the real git repository before believing a word of it.

Nobody is waiting on a human here. It is one agent making two CLI calls, the same two-phase shape
`empo review` already has between its brief and its findings ([06-cli](06-cli.md)).

What this buys, and it is the whole argument for accepting a model-fetched artifact at all:

- Six would-be connectors, six token stories and six APIs to version become zero. One kind covers
  Bitbucket, GitLab, Jira, Asana and Linear at once, and the next host needs no code.
- The CLI still holds no token, makes no network call, and `engine/git.ts` stays the only module that
  runs a subprocess. Nothing about the claims this project makes for itself changes.
- **The model's answer is checked against something the model does not control.** A hallucinated pull
  request has an id, a title and two entirely plausible branch names. What it does not have is
  branches that resolve in this checkout, and that is what fails it.

### `host` is a name to print, never a branch

Both adapter sections carry an optional free-text `host` ("bitbucket", "jira", "linear"). **The
engine never branches on it.** Every `mcp` adapter behaves identically whatever it says. Its one job
is to be interpolated into the request block so the agent knows which of its tools to reach for
("fetch it with your Bitbucket tool"). A config with `kind: "mcp"` and no `host` still works; the
request block then says "your pull request tool" instead of naming one.

A `switch` over this value would break the day a team names a host nobody anticipated, which is
exactly what a free string is for and exactly what the closed `kind` enum is for. There is one place
in the tool that reads `host` as more than a name, and it is still only printing: a `host` of
`bitbucket` adds a field-mapping table to the request block. No behaviour hangs off it.

The asymmetry that used to sit here is gone, and it is worth saying so rather than deleting the
paragraph, because this page pointed at it for two revisions. The payload schemas below refuse an
unrecognized key and name it; `config.json` used to drop one in silence, so a misspelled `host`
produced a request block saying "your pull request tool" and no complaint anywhere. The config schema
refuses it too now, on the same rule and with the same message shape
([03-config-schema](03-config-schema.md)). Both sides of this page now behave alike.

### The payload, and why almost nothing has a default

Both payload schemas are strict: an unrecognized key is refused with the key named, rather than
dropped. A dropped key means a renamed field is silently ignored and the agent is told nothing.

**A field whose absence is indistinguishable from a legitimate value is required, not defaulted.** So
`id`, `title`, `author`, `sourceBranch`, `baseBranch`, `description` and `url` are all required on a
pull request payload, and an empty string is allowed. Writing `""` costs the agent nothing, and `""`
is a statement where a missing key is a silence. Concretely: with a default of `""`, an agent that
read the wrong field would produce a payload that validates, a review that runs, and a brief showing
a pull request with no description, while nothing reported that a field had failed to map.

The ticket payload requires `key`, `title`, `type`, `body`, `comments`, `url` and `completed` for the
same reason. `type` is worth calling out: it has no default, so a writer who cannot tell has to say
`"unknown"` out loud. "I looked and could not tell" and "I did not map this field" are different
facts, and only the first of them should be quiet.

Four fields are optional, and each absence is a fact the review states:

| Field | On | Absent means | `[]` or a value means |
|-------|----|--------------|-----------------------|
| `comments` | pull request | the agent did not read them, and the adapter declares no `comments` capability | it read them; `[]` says there are none |
| `ci` | pull request | the pipeline was not checked, and `getCiResult` answers `unknown` | the state it reports |
| `headSha` | pull request | nothing checks the payload against the commit this checkout is at | the staleness comparison below runs |
| `criteria` | ticket | derive them from the body, the way every shipped tracker does | the ticket's own list; `[]` says it states none |

Those four are the only places a default would have hidden something worth reporting, and they are
handled by keeping "not fetched" and "fetched, there are none" apart rather than by collapsing them.

**`comments` is optional on a pull request and required on a ticket, and that asymmetry is
deliberate.** The forge declares its `comments` capability from whether the key is present, so an
absent list survives all the way into a report that says the comments were not read. Ticket comments
are where an author scopes a sub-item out, and step 6 is required not to flag what a comment
retracted, so an empty list reads as "nobody withdrew anything" and licenses exactly the finding a
fetched list would have withdrawn.

`Ticket.comments` is `TicketComment[] | null`, so the loss this requirement was
protecting against can be expressed in the type: `null` is "nobody fetched them" and `[]` is
"somebody looked and the ticket carries none", and `empo review` prints the two apart on both
surfaces. **The payload requirement stays anyway, and that is a decision rather than a leftover.** A
payload is written by an agent that can be asked to go and look, so making the absence expressible
here would make not looking the cheapest thing to write: writing `[]` without looking is a claim
somebody can be shown to be wrong about, where omitting the key is a silence nobody can see. The
nullable field downstream is for a transport that genuinely did not answer, which is a fact about the
tracker rather than a choice the writer of a payload gets to make. In practice only `github-issues`
reaches null, because `comments` is asked for by name in its `gh --json` call and a response without
it is `gh` not having answered; the `mcp` tracker is always a list because this boundary holds, and
`none` builds no ticket at all and carries its absence as a `skipReason`.

`sourceBranch` and `baseBranch` additionally refuse an empty string, for the reason the `github`
adapter already gives: the base decides what "the diff" even means for a stacked pull request, and a
review against a guessed base is worse than a review that did not run.

### The gate

This is the product, not a formality. Before a review runs, `verifyPullRequest` checks:

1. The payload's `id` is the id that was asked for. Fetching one pull request and being asked about
   another is a one-keystroke mistake, and nothing downstream would notice it.
2. `baseBranch` resolves to a real commit here, tried as written and then as `origin/<branch>`. Those
   two spellings are the whole of it; when neither resolves the check fails rather than reaching for
   the network, for the reason "the gate does not fetch on its own behalf" gives below.
3. `sourceBranch` the same way.

Every failure is a sentence naming what was wrong, and they are reported together rather than one per
round trip, so an agent that has to fetch again learns everything on the first try. The result is
exit 2, a config error: nothing about the environment is broken, the agent handed over a payload it
can fix and hand over again.

**The gate hands back the ref that resolved, and the diff uses that and never the raw payload name.**
A first draft returned only a list of problems, which threw away the one thing verification had
learned, and it reproduced a bug immediately: a branch present only as `origin/feature-x`, which is
the state of every pull request the reviewer has not personally checked out, passed verification and
then failed `git diff main...feature-x` with "unknown revision". Nearly every real review would have
hit it. The fix is not to repeat the local-then-origin fallback inside each adapter, because two
spellings of one rule in two files is how these drift apart.

**The gate does not fetch on its own behalf.** It resolves, and reports which spelling worked or that
none did. Fetching belongs to `empo review`, which already owns it for the `github` path. A gate that
mutates the repository in order to make itself pass is not a gate.

### Staleness

A subprocess adapter fetches at review time. A payload file was written at some earlier moment,
possibly against a different push. So the pull request payload carries an optional `headSha`, and
verification compares it against the commit `sourceBranch` actually resolves to.

The comparison is a **prefix match in whichever direction is shorter**, because Bitbucket returns an
abbreviated 12-character hash and git resolves a branch to a full 40. A plain equality check would
fail on every Bitbucket payload.

A mismatch joins the same list of problems the branch checks write to, which means it refuses the
review rather than annotating it, and the wording keeps the two real causes apart: the local checkout
has not fetched the newer commit, or the payload is stale. Refusing is the right side of that call
because both causes mean the review would read code the pull request does not contain, and there is
nothing a reader can salvage from confident findings about the wrong commits. It is also the cheap
failure. Exit 2 says the environment is fine and the payload is fixable, and the sentence it prints
names the two fixes, so the agent runs `git fetch` or fetches the pull request again and is back where
it was. An absent `headSha` reports nothing, because not every host supplies one.

The request block asks for it as an optional field, and says what omitting it costs: nothing checks
whether this checkout is at the same commit the pull request is, so a payload written against an
older push produces a confident review of code that was replaced.

For Bitbucket it says one more thing, and it is the right instinct written down. `headSha` is not in
the field-mapping table below, because no field for it was confirmed against a real response. So the
block tells the agent to write it if the same call happens to carry the source branch's hash, and
**not to compose one from a second call** to make the field present. A staleness guard fed by a value
fetched from somewhere else is checking that two calls agree with each other, not that the payload
matches this checkout.

### Where the payload lives is a security decision

The path is derived and never configurable. It is `pull-request.json` and `ticket.json` inside the
review's own scratch directory in the OS temp directory, described below, which already hashes the
canonical repo root into its name so two checkouts reviewing the same id cannot read each other's
payload.

This extends the rule the next section states rather than repeating it, and for a sharper reason than
tidiness: **the payload carries pull request descriptions and ticket bodies from private trackers.**
`.empo/` is the directory a team commits. A configurable path is a path somebody eventually points
inside the repository, and then the first team that configures a tracker commits a customer's ticket
body into git. There is deliberately no config field for it.

### The Bitbucket field mapping

When `host` is `bitbucket`, the request block prints the field-by-field mapping: one
`bitbucketPullRequest` call with action `get`, the workspace and repo slugs from config, and the pull
request id from the command line, and where each payload field comes from in that response.

**The field names are not repeated here.** They live in one place, the request block, which is
printed by the code that reads the payload back, so that copy cannot drift from what EmPo will
actually accept. A copy in this file could, and nothing mechanical would notice: `src/discipline/`
is test-pinned because it ships and is loaded at runtime, and nothing under `docs/` is read by any
test. An unguarded second copy of reference material is a guarantee with no owner.

The generated host instructions used to carry a third copy and no longer do, for the same reason, and
the absence is pinned in both directions: five assertions across the host specs check the mapping is
**not** in the generated block, while the review spec checks the request block **does** carry it. So
the way to see the current mapping is to run `empo review <id>` against an `mcp` forge with
`host: "bitbucket"` and read what it prints.

What belongs here is why the mapping says what it says, which is the part a reader deciding whether
to trust this design needs and which no request block explains.

**Every row was confirmed against a real pull request**, not read off a schema, and two of them came
back different from what desk research produced. Research concluded from the REST swagger that there
is no top-level `description` and that the body lives only at `rendered.description.raw`; against the
real response `description` is present at the top level and `summary.raw` carries the identical
string. The swagger described a different surface than the one the agent sees. And the author's
display name, which research could only mark as inferred, is confirmed. That is the project's own
lesson firing twice: a claim about somebody else's software is cheap to verify and expensive to get
wrong, and desk research is not verification.

An empty description is real and common: one of the pull requests read had `description: ""` and
`summary.raw: ""`. That is the concrete case the no-defaults rule above exists for. The agent writes
`""` and does not go hunting for the text elsewhere.

**CI is genuinely unavailable through this surface.** The pull request object carries a
`links.statuses.href`, so the REST API has it, but no action on any of the five Bitbucket MCP tools
exposes it. So the payload omits `ci`, the adapter declares no `ci` capability, and the review states
that the pipeline was not checked. A Pipelines call is not a workaround for this and is not offered
as one: it sees Bitbucket Pipelines only and misses third-party CI entirely, which is a weak signal
that would read as a strong one, and inventing a green build is the failure invariant 1 of
[07-review-discipline](07-review-discipline.md) exists to prevent.

**The agent must not fetch the diff**, even though an action for it exists. EmPo computes the diff
locally with git from the two branch names. This is stated explicitly in the request block, because
an agent will otherwise fetch it out of habit, and it matters twice over: the one artifact this
review reads line by line is then the one artifact no model has touched, and a fetched diff also
arrives redirected, truncated at the host's file and line caps, and slower.

**One copy of the field names, and it is the one the gate enforces.** This section carries the
reasoning and no reference table, the generated host instructions carry neither and say where to look
instead, and the request block carries the table. That split is not about tidiness: a doc that has
drifted misleads a reader, while a request block that has drifted produces a payload the gate
refuses, so the copy that fails loudly is the copy worth keeping. Adding a second one back is the
thing to resist, and the host specs will fail if it goes back into the generated block.

### What the `mcp` forge can and cannot do

Capabilities are declared from what the payload actually contains, which is the rule the interface
already states:

| capability | present when |
|------------|--------------|
| `pr` | always: a payload is what constructs this adapter |
| `diff` | always: git computes it locally |
| `comments` | the payload carried a `comments` key |
| `ci` | the payload carried a `ci` key |
| `post` | never in this version |

No `post` means `--post` has nowhere to go on an `mcp` forge, and it is worth being exact about what
actually stops it, because the capability set is not what does. Nothing in the review consults that
set before calling: `approve` and `requestChanges` have no caller anywhere in the shipped code, and
`comment` is called directly for each surviving finding whenever `--post` was passed. What refuses is
the adapter itself, whose three mutating methods throw an environment error naming the host rather
than doing nothing. So the declared capability is what the brief prints, so a reader knows posting was
unavailable, and the throw is what makes the refusal true. The interface does carry a `hasCapability`
helper for the up-front check, and it has no call site; that is the same gap the last section of this
doc names as the obvious next thing to add.

### Known limitations, stated rather than discovered

- **Only the `origin` remote is read.** In a fork workflow `empo init` seeds the fork's workspace and
  repo, so reviews would ask the agent for the pull request as it exists on the fork rather than
  upstream. Configure `adapters.forge` by hand there.
- **A project path of three or more segments loses information, except on gitlab.com.** The
  workspace and the repository are taken as the last two segments of the remote path, which is the
  common spelling on GitHub and Bitbucket, and a Bitbucket Server url's leading `/scm/` is transport
  rather than identity. GitLab is the exception, because a subgroup is part of the project's name:
  on gitlab.com and its subdomains the whole group path above the repository is the workspace, so
  `acme/backend/api` comes out as workspace `acme/backend` and repo `api`. A self-hosted GitLab is
  an unrecognized hostname here, so it keeps the two-segment reading and a nested project there
  still needs the workspace written by hand.
- **The default `keyPattern` does not fit Asana**, in a way that is worse than not matching at all.
  See the tracker section below.

## Tracker adapter

Abstracts where acceptance criteria live. The interface:

| Capability | What it returns |
|------------|-----------------|
| `extractKey(branch, title, body)` | the ticket key, using config `keyPattern`, cross-checking branch against title |
| `getTicket(key)` | title, body, type, acceptance criteria, comments, permalink, completed flag |

`extractKey` is where the ticket-key convention lives. `keyPattern` (`[A-Z]{2,}-\d+`) covers Jira
`PLAT-1234`, Linear `ENG-42`, and a third host's `OPS-7` without hard-coding any of them.
Branch names carry typos, so the adapter cross-checks the key found in the branch against the key in
the title and prefers the title for the lookup, the branch for the checkout.

### Tracker adapters

| `kind` | Transport | In this version |
|--------|-----------|-----------------|
| `mcp` | a JSON payload the agent host fetched | shipped |
| `github-issues` | `gh issue view` | shipped |
| `none` | no ticket; the review skips ticket-fit and says so | shipped |

The `jira`, `asana` and `linear` kinds this table used to list are gone, replaced by `mcp` with
`adapters.tracker.host` naming which one, for the reason the forge section gives: a CLI that makes no
network call cannot reach an MCP server, so the ticket arrives as a payload EmPo validates rather
than as an API call EmPo makes.

The review's ticket-fit step ([07-review-discipline](07-review-discipline.md) step 6) is identical
across all of these; only `getTicket` differs. A ticket "type" (bug vs feature) maps to a coverage
expectation (a bug wants a regression test), and the adapter normalizes each tracker's type
vocabulary into that.

The `mcp` tracker adds two rules of its own, both about refusing to grade the wrong thing:

- **A payload whose `key` is not the key EmPo extracted is discarded, not used.** Grading a diff
  against another ticket's acceptance criteria produces confident findings about work nobody asked
  for, which is exactly the kind of output this project exists to prevent.
- **No payload is a skip, not an error.** The tracker reports that no ticket was supplied, and the
  report says ticket-fit was not graded. That is not the same statement as "the ticket had no
  criteria", and the two must not collapse into each other.

**An `mcp` tracker is asked for independently of the forge**, which it was not at first. The request
block is a forge feature, so a `github` forge beside an `mcp` tracker printed no block at all and the
skip above fired on every single review: the tool stated its blind spot honestly and nothing ever
gave anybody a way to fill it. `empo review` now asks a second time, after it has fetched the pull
request itself, and that ask is the sharper one because the key is already extracted: it names one
ticket rather than printing `keyPattern` and delegating the match
([06-cli](06-cli.md), "A fetchable forge with an unfetchable tracker"). The two asks never both fire,
because an `mcp` forge's own block already carries a ticket section.

That second ask is a stop, so it ships with `--no-ticket`, an exit that is not a payload: a key
extracted from a real pull request can still name a ticket this tracker does not hold or this agent
cannot reach, and without a way to say so the same ask fires on every rerun. Saying so is recorded as
its own answer rather than folded into the skip above, because "nobody supplied a ticket" and
"somebody went looking and came back empty" are the same silence only if you never asked.

### The Asana trap in `keyPattern`

Worth stating on its own, because it fails in the worst available way. **Asana has no human-typeable
ticket key.** A task is named by a bare numeric gid or by a pasted permalink. A gid is 16 digits,
which is past what a JavaScript number holds exactly, so it has to stay a string end to end and must
never be parsed into one on the way through.

The shipped default `keyPattern`, `[A-Z]{2,}-\d+`, does not fit that. If it simply never matched, the
review would say there is no ticket and be right. What it does instead is worse: many Asana
workspaces carry an auto-numbered custom field whose values are spelled exactly like a Jira key,
`ACME-1234`, and the default pattern **matches it**. EmPo extracts a key, the request block asks the
agent to fetch that ticket, and no Asana tool can resolve it, because it is a field value and not an
identifier. A pattern that matches and then fails costs a round trip and reads like a broken tracker;
a pattern that never matches reads like what it is.

So an Asana tracker needs `keyPattern` written to match a gid or a permalink, and this is a place
where the default is actively wrong rather than merely unhelpful. See
[03-config-schema](03-config-schema.md).

There is a second trap in the same family, on the payload rather than the config, and the request
block warns about it explicitly. The payload's `key` must be **the string that was matched, echoed
back character for character**, and not the host's own identifier for the same ticket. An agent that
fetched an Asana task did so by its gid and has no other native identifier to hand, so writing the
gid into `key` is the natural move. EmPo matches that field against the key it pulled out of the pull
request, a gid never matches, and the failure is silent in the worst way: the review reports the
ticket as not found, which reads as a ticket that does not exist rather than as a payload filled in
wrong. The gid and the permalink belong in `url`, where nothing is matched against them.

## Where a review's scratch lives

Everything a review writes goes to a per-review directory in the OS temp directory,
`<tmp>/empo-review/<id>-<hash>/`, and never under `.empo/`. The `<hash>` is eight hex characters of
the canonical repository root, for the reason the payload section above gives and the comment on
`sessionDir` spells out: the id alone does not identify a review, since a local one is always
"local", so every checkout on one machine would share a directory and tear down each other's. The
readable id stays in the name so a human can still find the directory a brief just named. It holds `pr-<id>.diff`, a `session.json`
recording the read root, the base and the source branch that phase 2 verifies against, the detached
`worktree/`, and, for an `mcp` adapter, the `pull-request.json` and `ticket.json` the agent host
writes there. `generated/` is machine-owned by `empo index` alone
([02-on-disk-layout](02-on-disk-layout.md)), and the second invariant of
[07-review-discipline](07-review-discipline.md) is taken literally: a review writes nothing into the
working tree under review. The one exception is git's own worktree bookkeeping under
`.git/worktrees/`, which teardown clears. Phase 2 removes the worktree and the directory once it has
printed the survivors, and starting a new review of the same id clears the previous session's
worktree before it begins, so a crashed review costs a stale temp directory and never a dangling
worktree in the human's checkout.

A payload therefore lives exactly as long as the review that asked for it. Rerunning a command that
worked once finds its own `--pr-payload` path gone, which is why the request block treats a
named-but-missing payload as "not fetched yet" and asks for a fresh fetch, instead of reporting a
missing file and sending the agent looking for something that was deliberately removed.

## Graceful degradation

Every adapter is optional and its absence degrades cleanly, never crashes:

- No `forge`: `empo review` operates on the local diff against `--base`. Ticket lookup still works
  if a tracker is configured and the branch carries a key.
- An `mcp` `forge` with no payload yet: `empo review <pr>` prints the request block and returns
  **exit 0** without reviewing. This is a handoff and not a degradation, so it is worth keeping apart
  from the rows around it: nothing failed, the next step simply belongs to the agent.
- No `tracker`: the review runs without ticket-fit grading and states plainly that criteria were not
  checked. Impact and coverage findings are unaffected.
- Neither: `empo review` is a local-diff impact-and-coverage review. Still the whole verification
  funnel, just without PR metadata or acceptance criteria.

The choice happens in `createForge` and `createTracker`, and neither throws: every path ends in a
working adapter plus a `note`, which is `null` when the configured adapter is the one used and a
sentence naming the reason when it is not. A `gh` that is not on PATH, and a `kind` this version does
not implement, both come back that way. The review prints those notes at the top of the brief,
beside the facts, so a degraded run is stated in the report rather than discovered later: a reader
who is told "the local diff against `main` is under review instead" knows what they are reading,
and a reader who is told nothing assumes the pull request was read. A tracker carries a second one,
`skipReason`, which is what the report prints in place of ticket-fit grading, for the same reason.

`empo doctor` says the same things one step earlier, and it is the command to run when a review keeps
degrading and nobody knows why. It states both adapters in every report, whether the CLI a configured
kind needs is on PATH, and what the `origin` remote says the forge is, and it warns on the two states
config asks for and cannot have here: a missing `gh`, and an origin on a recognized host of a
different kind from the configured forge ([06-cli](06-cli.md)). A tracker nobody configured is stated
there as a fact and never as a warning, because it is a legitimate setup and the reader asking why
ticket-fit never ran is the one it exists for.

This matters for adoption: a new user with no adapters configured still gets value from
`empo query` and a local `empo review` on day one.

## Publishing etiquette (adapter-carried, off by default)

Posting to a PR or a tracker is outward-facing, so it is never automatic and every default is off.
The etiquette that governs it is team-specific and lives with the adapter, not in the universal
discipline:

- **Findings are shown in chat by default, not posted.** `--post` opts in. A posted comment reads
  as a normal human review: it never names the tooling that produced it (no tool, skill, or agent
  names in the body), and it states the finding on its own merits.
- **Language and formatting of posted content are a team convention**, configured per adapter (one
  team posts customer-facing notes in Dutch with a specific HTML subset; another posts in English
  markdown). EmPo ships no opinion on this beyond "off unless asked, and never leak the toolchain."
- **A posted comment is checked for stylistic tells before sending**, stripping em-dashes being the
  obvious one. This is meant to be a configurable final-pass scrub, not a hard-coded rule.

These are documented here so an implementer knows where they go, but they are the last thing built
and the most team-specific. The core product is the review in chat; posting is a convenience layer
on top.

What this version ships is the floor of that. `--post` sends each verified finding through the
forge adapter's `comment`, with the title, the claim and the suggestion as the body and the
repo-relative `file:line` at its head, because `gh pr comment` posts at the top level and exposes no
line anchor, and dropping the anchor would leave the author with a claim and no line. One scrub
runs, on em-dashes, and it is hard-coded rather than configured. The per-adapter language and format
conventions are still unbuilt.

`github` is the only forge that declares `post` in this version. An `mcp` forge cannot post at all:
posting is a write, and every write in this design would have to travel back out through the agent,
which is a second round trip nobody has specified yet. So the honest reading is that this version
reviews Bitbucket and GitLab pull requests without writing to them, and `--post` against an `mcp`
forge fails as an environment error (exit 3) after the verified findings have been printed. The
findings are not lost, but the refusal arrives later and louder than a capability check up front
would make it, and that check is the obvious next thing to add here.
