# 03. Config schema

`config.json` is the layer-4 file. It tells EmPo the shape of the repository (roots and their
languages), which cross-language couplings to resolve (bridges), and which forge and tracker to
talk to (adapters). It is human-owned, seeded once by `empo init`, and rarely touched after.

## Full example (a PHP + TypeScript monorepo)

The same config as one copy-pasteable file lives at
[`examples/empo.config.example.json`](../examples/empo.config.example.json), field for field, with one
`_note` at the top saying the repository it describes is invented.

```json
{
  "version": 1,
  "roots": [
    { "path": "apps/api",        "lang": "php",        "framework": "laravel" },
    { "path": "apps/mobile",     "lang": "typescript", "framework": "react-native" },
    { "path": "packages/shared", "lang": "typescript" }
  ],
  "packs": {
    "php":        { "version": "^1", "options": { "namespaceRoot": "Acme" } },
    "typescript": { "version": "^1" }
  },
  "bridges": [
    {
      "kind": "http-route",
      "produces": "apps/api",
      "consumes": ["apps/mobile"],
      "normalize": { "stripPrefix": ["/api", "/v1"], "collapseParams": true }
    }
  ],
  "flows": ".empo/flows.json",
  "spines": ".empo/spines",
  "adapters": {
    "forge":   { "kind": "github", "repo": "platform", "workspace": "acme" },
    "tracker": { "kind": "mcp", "host": "jira", "keyPattern": "[A-Z]{2,}-\\d+", "project": "PLAT" }
  },
  "ignore": ["**/vendor/**", "**/node_modules/**", "**/dist/**", "**/*.stories.tsx"],
  "commit": ["generated"]
}
```

## Field reference

### `roots` (required)

The repository is a list of roots, each a directory with one language. This is what makes EmPo
monorepo-native: a single-package repo simply has one root.

| Field | Required | Meaning |
|-------|----------|---------|
| `path` | yes | Directory relative to repo root. Everything under it is indexed with this root's pack. |
| `lang` | yes | Which language pack indexes this root. Must match a key in `packs`. |
| `framework` | no | A hint the pack may use to enable framework-specific extractors (Laravel routes, RN navigation). |
| `aliases` | no | What a non-relative import specifier this root's files write (`@/lib/money`) stands for, as a tsconfig `paths` map. Without it every aliased import resolves to nothing. |

`path` is flattened when the config is validated: a leading `./` and a trailing `/` are dropped, so
`./apps/api/` is stored and printed back as `apps/api`, and both sides of a bridge get the same
treatment because they name a root by that same path.

Every root is scanned on its own, so a file two roots contain yields a node under each of them.
Dedupe keeps one node per id, and where two nodes name the same file the one from the most specific
root survives, because a pack matches its path rules against the path relative to the root that
scanned the file. `empo index` warns and names the two roots, since the repair is to narrow one or
add an ignore. Files under no root are not indexed, and `empo doctor` names the top-level
directories no root covers, so an unmapped tree is something you are told about rather than
something you notice missing. Deeper than the top level it stays quiet: that needs the scanner.

`framework` stays a human's field. `empo init` detects the language of a root and never its
framework: nothing in a pack's `match` block carries a framework signal
([04-language-packs](04-language-packs.md)), so a generated hint would be the engine guessing at a
language specific, which is the one thing the pack contract exists to keep out of the engine. A human
writes it and the pack acts on it.

#### `aliases`, the one field that decides whether an import resolves at all

Most languages let a specifier that looks like a package name point at a file in this repository.
`import { money } from "@/lib/money"` is a package name to every rule a pack can write and a path to
the toolchain that compiles it, and only the repository knows which. So the map lives here:

```json
{
  "path": "resources/js",
  "lang": "typescript",
  "aliases": {
    "@/*": ["resources/js/*"],
    "@shared/*": ["packages/shared/src/*", "vendor/shared/src/*"],
    "@config": ["resources/js/config/index.ts"]
  }
}
```

**It is spelled like a tsconfig `paths` map, field for field**: a pattern holding at most one `*`, a
**list** of targets rather than a single one, and an exact pattern with no `*` at all allowed beside
the wildcards. That shape is worth more than a tidier one, because it makes seeding a copy rather
than a translation. `empo init` writes what the toolchain already says, a human reading the tsconfig
can check the config against it line by line, and a shape that took one target would quietly seed a
narrower map than the build runs on with nothing printed to show the difference.

**Targets are repo-relative**, which is the one place the spelling departs from tsconfig, whose
targets are relative to `baseUrl`. Node ids are repo-relative ([05-graph-model](05-graph-model.md)),
so a repo-relative target is directly comparable with the ids the resolver matches against, while a
root-relative one would have to be joined to a root before any comparison and would be the third path
form in a tool that already documents having two (`file` and `relPath`). It also lets an alias point
out of the root that declares it, which is what a monorepo package alias normally does and what any
other rule would need a special case for.

**Matching order is the toolchain's, because the map is a copy of the toolchain's.** Exact patterns
first, then wildcards by the length of the text before the `*`, longest first: `@/lib/*` beats `@/*`
for `@/lib/money`, and an exact `@/config` beats both for that one specifier. Equal specificity is
tiebroken by `compareStrings` (`engine/order.ts`) and never by the order the keys were written, which
matters more here than the tie ever will: JSON preserves key order, nothing else in the engine relies
on it, and this is the one field where a config's key order could have reached `graph.json` and broken
determinism. Inside the chosen pattern the targets are tried in **declared** order and the first that
names a node wins, exactly as a tsconfig `paths` list means, so `["packages/shared/src/*",
"vendor/shared/src/*"]` and its reverse are two different maps.

**Only the best-matching pattern is tried, and nothing falls through to a worse one.** Where the best
pattern's targets name no node, the specifier resolves to nothing, even though a less specific
pattern would have matched it. The other direction was available and was rejected: falling through
manufactures an edge to a file the compiler would never have loaded, and a plausible wrong edge is
worse here than a missing one, because a blast radius is read as a floor and a floor made of invented
couplings is not one. An alias nobody wrote down resolves to nothing for the same reason. Nothing in
this field is guessed at.

**Two spellings are refused at parse time rather than accepted and ignored.** A pattern or a target
holding more than one `*` fails, which is tsconfig's own rule and the honest one: two stars need a
decision about which of them the matched text belongs to, and the toolchain this map is copied from
does not make that decision either. A pattern beginning `./` or `../` fails too, because a relative
specifier is resolved against the importing file and answers before the alias map is ever consulted,
so such a key would sit in the config looking like it did something and match nothing forever. That
is the same silent-no-match failure the `path` flattening above exists to prevent, arriving through a
different field.

**`empo init` seeds it; `empo index` reads only what the config holds.** Init opens the toolchain
config the root's pack names (`aliasSources`, [04-language-packs](04-language-packs.md)), follows a
relative `extends` chain, writes what it found and prints both the map and every gap it hit
([06-cli](06-cli.md)). Index opens no tsconfig, ever. The graph stays a function of the config plus
the files under the roots, which is what keeps it reproducible on a machine with no toolchain
installed and byte-identical between runs.

**The cost of that is a copy that can go stale, and it is stated rather than hidden.** The map is
taken once. A tsconfig edited afterwards drifts from the config until somebody reruns `empo init`,
which reports what it would have written and still overwrites nothing, or edits the field by hand.
What a build resolves is whatever the human left here. One face of the drift is caught: `empo doctor`
warns where an alias target's literal parent directory is not in the checkout, which is the likeliest
way the field rots, since a seeded map survives the move of the directory it points at. The rest is
not detected, and an alias that points at a directory which still exists and no longer holds the
module is silence.

### `packs` (required)

Which language packs to load and their versions. A pack is data (extraction rules); see
[04-language-packs](04-language-packs.md). `options` are pack-specific (a PHP pack wants the
namespace root; a Go pack wants the module path).

### `bridges` (optional, but this is the monorepo feature)

Each bridge tells the symbol-table matcher to resolve one kind of cross-language coupling.

| Field | Required | Meaning |
|-------|----------|---------|
| `kind` | yes | The symbol kind to match. `http-route`, `event`, `queue`, `flag`, `storage-key`, or a pack-defined kind. |
| `produces` | yes | Root (or roots) whose files publish this symbol (the definer side). |
| `consumes` | yes | Root(s) whose files reference this symbol (the caller side). |
| `normalize` | no | Rules to make both sides comparable: strip a URL prefix, lowercase, drop a trailing slash, collapse path params (`{id}` vs `:id`). |

`normalize` matters more than it looks. The backend registers `api/v1/orders/{id}` and the
frontend calls `/orders/42`. Without normalization (strip `/api` and `/v1`, collapse the id
param) they never match and the bridge finds nothing. `empo doctor` reports bridge match rates so
you can tell a mis-tuned `normalize` from a genuinely absent coupling.

`kind` is whatever symbol the two packs on either side produce and consume, not a closed set. A
Laravel + Inertia + Vue repository wires the page render with

```json
{ "kind": "inertia-page", "produces": "resources/js", "consumes": "." }
```

because the typescript pack `produces` `inertia-page` from each `Pages/*.vue` file's path and the php
pack `consumes` it from every `Inertia::render('...')` call ([04-language-packs](04-language-packs.md)).
The page names on both sides are already equal, so this bridge needs no `normalize`. With it,
`empo query` on a controller names the Vue page it renders, and on a page names the controllers that
render it; without it those pages read as orphans, reached by nothing the graph can see.

The four rules, each applied to a whole key rather than to a part of it, and both sides run through
the same function so nothing is normalized on one side and not the other:

| Rule | Does |
|------|------|
| `stripPrefix` | Removes each listed segment where it stands as a whole path segment with something after it. Stripping `api` turns `POST api/v1/orders` into `POST v1/orders` and leaves `POST v1/apiary` alone. Write it with or without slashes. |
| `collapseParams` | Replaces every spelling of "this segment is a value" with one wildcard: `{id}`, `:id`, `${id}`, `<id>`, and a segment that is already a number, because the calling side usually holds a literal. |
| `lowercase` | Lowercases the key, method included. Both sides get it, so the join still holds. |
| `stripTrailingSlash` | Drops a trailing `/`. |

**`stripPrefix` needs a slash after the segment, so a listed segment in final position stays.** The
match is on `segment/`, at the start of the key or after a space or a slash, which is what keeps
`api` from eating the front of `apiary`. Two things follow from that shape and neither is obvious
from the name. It is not restricted to the front: every occurrence goes, so `POST v1/api/orders`
loses its `api` too and `GET api/x/api/y` loses both. And a segment with nothing after it has no
slash to match, so `GET v1/api` keeps its `api` however plainly it is the segment you listed. No rule
in this table removes a final segment, so a key that ends in the thing you wanted gone has to be
fixed where the key is built, in the pack's `key` template, and not here.

**The rules run in the order the table lists them, and `stripPrefix` compares text literally, so a
rule set can lose a match that a smaller one would have found.** `stripPrefix` runs first, before
`lowercase` has had a chance to make the two sides agree. Give a producer writing
`POST API/v1/orders` and a consumer writing `POST api/v1/orders` the rules
`{ "stripPrefix": ["api"], "lowercase": true }`, and the producer normalizes to `post api/v1/orders`
while the consumer normalizes to `post v1/orders`, so the bridge finds nothing where `lowercase`
alone would have matched them exactly. Both sides did go through the same function; treating two
differently-cased inputs identically is precisely what pulled them apart. So write the prefix in the
case the files actually use, and where the two sides disagree on case, list both spellings
(`"stripPrefix": ["api", "API"]`), since every listed prefix is applied in turn. A bridge that
matched before a `normalize` rule was added and matches nothing after it is this, and the repair is
to look at the case of the prefix rather than at the rest of the config.

Both sides are counted in **keys**, not edges, and that is what `empo index` and `empo doctor`
print. The graph holds one edge per pair of files ([05-graph-model](05-graph-model.md)), so a mobile
file calling two routes in one route file is two matched keys and one edge. Reporting edges here
would contradict the `bridged` count that `empo index` prints a few lines above these, in the header
line that carries `stats.bridgedEdges`. `empo doctor` prints the same per-bridge lines under a header
that carries no bridged-edge count at all, so the contradiction is only visible under `empo index`,
and a unit that changed meaning between the two commands would be worse than one stated once.

**A side names a root exactly, and the match is by equality rather than by prefix.** A node carries
the root that scanned it, and a side collects the node when that root is one of the paths the side
lists, so a side naming `.` sees nothing at all from a node whose root is `apps/api`, however plainly
`apps/api` sits underneath `.`. Flows are assigned the other way round, by longest matching path
prefix ([05-graph-model](05-graph-model.md)), and that model does not carry across to here. Read
together with the overlap rule under `roots` above, this settles which of two nesting roots a side
should name: a file both roots scan survives as the node labelled with the more specific of them, so
that is the root a side referring to that file has to name. `empo doctor` checks each side against
the configured root paths by the same equality and reports a side naming something that is not a
root, which leaves one case it cannot report: a side naming a real root that none of the nodes it
means are labelled with. That one reads as a bridge with no matches, which is exactly how a coupling
that genuinely is not there reads.

No `bridges` at all is valid: every root is an island. Useful, not monorepo-aware. It is also what
`empo init` writes, because a bridge is a claim that two roots exchange a symbol under a
normalization rule and neither half of that is visible in a file listing. For a repository with two
or more languages init prints a note saying so, because until a bridge is configured `empo query`
reports no cross-language reach at all, and that is indistinguishable from a repository that
genuinely has no coupling.

**A bridge here is a claim only a human can make, and a pack join is a different thing that needs no
config at all.** Writing a bridge asserts that two roots somebody deliberately chose to keep apart
really do exchange a symbol, and that these particular `normalize` rules are what make the two
spellings of it comparable. Neither half of that is in a file listing, which is why `empo init` still
writes none and why it says so out loud. A pack's `joins` list asserts nothing about anybody's
layout: it says the framework the pack reads spells one call two ways — a Laravel scheduler entry and
the command class it names, both php — so the engine matches the produced key against the consumed
one **inside a single root**, needing no `normalize` because both halves are normalized by rules in
that one pack. The php pack declares it for `scheduled-command`; the pack side is
[04-language-packs](04-language-packs.md), and it is opt-in per symbol kind rather than "every symbol
this pack writes both halves of", since the php pack also consumes its own `http-route` keys from its
feature tests and joining that one would give every route a fan-in edge from its test.

Two things follow for anyone reading a graph. A `bridge` edge is no longer proof that a coupling
crosses a language ([05-graph-model](05-graph-model.md)), which is why every command now calls these
"joins" rather than "cross-language reach". And a single-language repository, which never gets a
`bridges` block at all, can hold them anyway — that is the point of putting the claim in the pack:
left to config, the edge would exist only where somebody already knew to ask for it, which is exactly
where it teaches nothing.

### `adapters` (optional)

Two adapters, each pluggable. Absent adapters degrade gracefully: no `forge` means `empo review`
works on a local diff instead of a PR; no `tracker` means the review skips ticket-fit grading and
says so. The `AGENTS.md` that `empo init` generates names whichever of the two is missing and what a
review therefore cannot know, which is a more useful state than a guessed adapter pointing at the
wrong host.

**forge** (which PR host):

| `kind` | How EmPo reaches it |
|--------|---------------------|
| `github` | `gh` CLI |
| `mcp` | it does not: the agent running EmPo fetches the pull request and EmPo validates the payload against git |
| `local` | no host; operate on `git diff` |

**tracker** (where tickets live):

| `kind` | How EmPo reaches it |
|--------|---------------------|
| `mcp` | it does not: the agent fetches the ticket and EmPo validates the payload |
| `github-issues` | `gh` CLI |
| `none` | no ticket grading |

**These tables used to list more kinds, and they described something that cannot exist.** The forge
table had `bitbucket` reached through "Atlassian Rovo MCP Bitbucket tools" and `gitlab` through
`glab`; the tracker table had `jira`, `asana` and `linear` each reached through their own MCP. EmPo
holds no token and makes no network call, and MCP in particular is driven by the agent host, whose
connectors authenticate interactively against a session this CLI is not part of. A CLI cannot reach
an MCP server. The five rows named a transport that does not exist at this layer.

All five collapse into one `mcp` kind on each adapter, and the inversion behind it is worth
understanding before writing the config: EmPo prints what it needs, the agent fetches it with
whatever connector it has, writes JSON, and EmPo checks that JSON against the real git repository
before believing it. [09-adapters](09-adapters.md) has the payload shape and the gate.

| Field | Applies to | Meaning |
|-------|------------|---------|
| `host` | `mcp`, either adapter | Free text naming the human-facing system: `bitbucket`, `jira`, `linear`. **The engine never branches on it.** It is interpolated into the request block so the agent knows which tool to reach for. Omitting it is valid; the block then says "your pull request tool". |
| `repo` | `forge` | The bare repository slug and nothing above it, for both kinds: `platform`, never `acme/platform`. |
| `workspace` | `forge` | The owner, workspace or group above the repository. What a Bitbucket tool wants as `workspaceId`, and what `github` joins onto `repo` to make the `OWNER/REPO` slug, the only form `gh --repo` takes. |
| `keyPattern` | `tracker` | The regex that finds a ticket key. See below. |
| `project` | `tracker` | The project or board the tickets live in, for the reader and for the request block. |

**The split between `repo` and `workspace` is not a Bitbucket detail that `github` is exempt from.**
Detection writes both fields for every kind: the last path segment of the `origin` remote becomes
`repo` and what stands above it becomes `workspace` — the one segment above on every host, and the
whole group path on gitlab.com, where a nested group is part of the project's name — and the join
back into `acme/platform` happens on the way out, in the one expression both the github adapter and
the generated `AGENTS.md` block go through. Writing the joined slug into `repo` while a `workspace`
is also present therefore produces `acme/acme/platform` in both places, which is a repository nobody
has, and the schema cannot tell that apart from a repository genuinely named that way. `empo doctor`
can, up to a point: where the `origin` remote is readable it prints the configured slug beside the
one origin names, so `acme/acme/platform` stands next to `acme/platform` in the forge line. It is
reported as a difference of slug and never raised as a finding, because a fork workflow has origin
on the fork while config names the upstream, and only a human can tell that from a mistake. Where
git cannot answer, no origin clause is printed at all and nothing catches it. Write the owner once,
above, and let the join do its work.

`host` is deliberately not an enum. An enum here would refuse a working connector for a host nobody
anticipated, and since nothing branches on the value there is nothing an unexpected one can break.
The closed set is `kind`, which is where a closed set earns its keep.

**A key this file does not know is refused, and the message names it.** Every object in the schema
is strict, at every level, so `"hsot": "jira"` fails validation on `adapters.tracker` and a config
that spells the section `"adaptors"` fails at the top level with `Unrecognized key: "adaptors"`. Both
exit 2, before anything has been indexed or reviewed, on every command that reads the config:
`index`, `review`, `check`, `doctor` and `init`. **`empo query` is the exception**, because it reads
`graph.json` and never the config, so a repository whose graph is already built still answers a blast
radius from a config it has not looked at. That is right for what `query` reports on, and it means a
typo is caught by the next command that reads config rather than by the next command at all.

That is a change from the version before this one, and the behaviour it replaced is worth keeping on
the record, because it is the reason a review can be honest and wrong at the same time. The schema
used to **strip** what it did not recognize. So `"adaptors"` was a valid config with no adapters at
all: the review ran on the local diff and skipped ticket-fit exactly as though that were what
somebody had configured, and `empo doctor` printed `forge not configured` and `tracker not
configured`, which is word for word what a repository that genuinely has no adapters is told. The
typo had no symptom that differed from the absence, anywhere, so no amount of reading the output
could find it. An uncompilable `keyPattern` was never the exception it looked like: the tracker
schema has always refused one at parse time, which is the same shape the whole file now has.

Two carve-outs, and both are keys that must be ignored rather than keys that are allowed. `$schema`
is the key an editor reads to find a schema document to validate the file against, whether or not
this project ever ships the one it can generate (see Validation below); it is written by tooling and
read by nothing in EmPo. `_note` is a comment, in the one language JSON has for one, and it is here
because turning the strictness on failed this repository's own shipped example, which carries its
"every value here is invented" disclaimer as a key. That disclaimer has to travel inside the file
people copy ([11-security-boundaries](11-security-boundaries.md)) rather than beside it. Both are
**declared in the schema** rather than allowlisted somewhere else, which also puts them in the
generated editor document, and neither is a rule about a prefix: "anything starting with an
underscore is ignored" would re-admit the silent strip for every key somebody spells that way by
accident.

The cost is real and it is the right way round. A config written for a later version of EmPo now
fails on an older binary instead of degrading. An unknown key is either a typo, where refusing it is
the entire point, or a feature this binary does not have, where ignoring it produces an answer
computed without the thing its author asked for. The payload, spine and proposal schemas in
[09-adapters](09-adapters.md) have refused unknown keys since they were written; this file used to be
the odd one out, and that difference was never principled.

**What `empo init` seeds.** The forge, from the `origin` remote, because the pull request host is
written there and asking a human for something already on disk is a worse command. GitHub becomes
`github`; every other host becomes `mcp` with `host` naming it, down to the bare hostname for a host
nothing recognizes, since the value is only ever printed. The url read is the **configured** one
(`git config --get-all remote.origin.url`, first value) and never what `git remote get-url` prints,
because that command expands `url.<base>.insteadOf`: a proxy, ssh-for-https or mirror rewrite is
local transport plumbing, and a checkout whose git points github.com at a loopback proxy is still a
GitHub repository. The tracker is never detected, because nothing in a checkout names where the
tickets live, and a wrong tracker is worse than none.
`empo init --tracker jira` writes `{ "kind": "mcp", "host": "jira" }`; otherwise no tracker section
is written and init says plainly that every review skips ticket-fit until one is. Neither half is
ever guessed, and `"adapters": {}` is never written, because an empty section reads as one somebody
configured and then emptied.

Upgrading from a config that names a retired kind is a one-line edit, and the error says which one:
a config with `"kind": "jira"` fails validation on every command with `"jira" is no longer a tracker
kind. Use { "kind": "mcp", "host": "jira" } instead.` That message exists because this is the one
error a user meets at the exact moment they upgrade, before a single command has run and before they
have any reason to trust this tool. Zod's own message lists the valid kinds and says nothing about
what became of theirs, which reads as the tool breaking rather than as a rename.

### `keyPattern`, and where its default is wrong

`keyPattern` is the regex that extracts a ticket key from a branch name, PR title, or PR body. The
default, `[A-Z]{2,}-\d+`, covers Jira `PLAT-1234` and Linear `ENG-42` alike. This is what lets the
review find the ticket without hard-coding one tracker's convention.

One tracker overrides that default rather than sharing it. A GitHub issue is `#123` and never
`PLAT-123`, so the `github-issues` adapter falls back to `#\d+` when config supplies no `keyPattern`,
and the cross-tracker default never applies there. Write a `keyPattern` and it wins on either
adapter, which is the only way a repository whose branches carry a Jira key while its issues live on
GitHub can be made to work.

**It does not fit Asana, and it fails in the worst available way.** Asana has no human-typeable
ticket key: a task is named by a bare numeric gid or a pasted permalink, and a gid is 16 digits, past
what a JavaScript number holds exactly, so it stays a string the whole way through. If the default
simply never matched, the review would report no ticket and be right. Instead, many Asana workspaces
carry an auto-numbered custom field whose values are spelled exactly like a Jira key, `ACME-1234`,
and the default pattern **matches that**. EmPo extracts a key, asks the agent to fetch that ticket,
and no Asana tool can resolve it, because it is a field value and not an identifier. A pattern that
matches and then fails costs a round trip and reads like a broken tracker. A pattern that never
matches reads like what it is.

So an Asana tracker needs `keyPattern` written for a gid or a permalink, and writing nothing is not a
safe default there. See [09-adapters](09-adapters.md) for the adapter contract.

### `ignore` (optional)

Glob patterns excluded from indexing. Vendored code, build output, and test doubles usually go
here. Test **files** are not ignored (the graph needs them to compute coverage); test **fixtures**
and generated output are.

`empo init` seeds exactly five patterns and no more: `**/node_modules/**`, `**/vendor/**`,
`**/dist/**`, `**/build/**` and `**/coverage/**`. A glob over test filenames is the one entry that
looks harmless and is not: ignoring test files would leave `empo query --blind` calling every flow in
the repository blind, and `empo check` finding no assertion anywhere, which turns both of the answers
this tool exists to give into noise.

**Whatever git ignores is dropped too, and this list never has to say so.** The five seeded patterns
are the trees every repository has; the tree that actually breaks a scan is the one only that
repository has, and nobody thinks to name it. A Laravel checkout keeps eleven thousand generated
`.php` files under `storage/framework/phpstan`, all gitignored, none of them matched by a seeded
pattern, and indexing them read 238MB of source into memory at once. So the scan asks git rather
than guessing: a path `git check-ignore` matches is not indexed. A repository that is not a git
checkout indexes exactly as before, and a gitignored file somebody force-added is tracked and stays.

### `commit` (optional)

A record of which `generated` artifacts the team decided to commit. Default is empty, which is what
`empo init` writes unless it is given `--commit-generated`, and with that flag it writes
`["generated"]`. See [02-on-disk-layout](02-on-disk-layout.md).

**It is read by one command, and reading it changes no behaviour.** The `.empo/.gitignore` that
decides whether `generated/` is actually kept out of version control is written by the same
`empo init` run, from the same `--commit-generated` flag, and not from this field. So editing
`commit` after init still adds and removes no `.gitignore` entry. What it does reach is
`empo doctor`, which asks git what it really does with `.empo/generated` and warns, never errors,
when git and this list disagree in either direction; [06-cli](06-cli.md) states the three states it
stays quiet in, of which the one worth knowing while writing this field is that a repository which
has never been indexed is never reported. Entries are compared with a trailing slash trimmed, so
`generated` and `generated/` are one decision written two ways. Edit `.empo/.gitignore` for the
behaviour and keep this field in step so the config still says what the repository does. Rerunning
`empo init` will not do either for you, because init keeps every file that already exists and writes
only the missing ones. Spelled out because a field that looks like a switch and is only a record is
worth knowing about before you flip it and expect git to follow.

## Validation

`empo init` writes a valid config, and proves it by running the config it built through the same
validator that reads it back before a single file is written, so the generator cannot emit a config
the rest of the CLI rejects. `empo doctor` validates an existing one and reports: roots that
point at missing directories, a `lang` with no matching pack, a pack that is not installed, a pack
the graph was built with that will not load, a bridge whose `produces`/`consumes` name a nonexistent
root, directories under no root, and, as warnings rather than errors, a `commit` list that
disagrees with what git does with `.empo/generated`, a CLI a configured adapter needs that is not on
PATH, a forge kind the `origin` remote disagrees with, and an `aliases` target whose literal parent
directory is not in the checkout. A `keyPattern` that does not compile is
not on that list and never reaches doctor, because the schema refuses it at parse time and every
command including doctor fails on the config itself.

A JSON Schema for `config.json` is generated from that same validator, but it exists only in memory:
a function returns the document, no command writes it anywhere, and the published package ships no
schema file. So there is nothing on disk for an editor's `$schema` to point at, and validate-on-save
is a thing this schema is ready for rather than a thing it currently does.

A key this schema does not recognize is not on that list either, and for a better reason than it used
to be: it never reaches doctor, because the schema refuses it at parse time and every command
including doctor fails on the config itself, exactly as an uncompilable `keyPattern` does. The
generated JSON Schema carries the same rule for free, since a strict object emits
`additionalProperties: false`, so an editor pointed at that document would flag a misspelled key
while it is being typed. That is still the on-disk gap above rather than a second one: the document
exists only in memory, so nothing is there for `$schema` to point at yet.
