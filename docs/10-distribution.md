# 10. Distribution

EmPo ships as two things: a standalone CLI binary (required, because there is real computation to do)
and the host configuration that CLI generates (optional convenience that wires the CLI into an agent
host). The CLI is primary. The wiring is sugar over it and holds no knowledge of its own. Never build
the wiring first.

## Why a CLI and not a pure prompt/skill

The core value (the dependency graph, fan-in, bridge matching, drift detection, the commit gate) is
**computation, not prompting**. It must run deterministically, in seconds, with no LLM and no
network, and be usable from a bare terminal. That rules out shipping EmPo as a markdown skill alone.
The CLI is the moat: anyone can write a review prompt, nobody gets the review right without the
generated ground truth underneath it.

OpenSpec is the model to copy for the *shape* of the tool: an `init` that scaffolds a per-project
directory, an `update` that regenerates host instructions, and many supported hosts reached through
generated instruction files rather than through a bespoke integration each. The one deliberate
divergence is that OpenSpec's CLI only writes markdown while EmPo's CLI also **computes**, and that
computation is the reason EmPo exists. The channel is not copied from it; that is the next section.

- **Language**: TypeScript on Node (Node 22.12+), which is the review host's own runtime and the
  fastest thing to build a graph engine in. The CLI being TS does not tie the *targets* to TS; the
  target language is whatever the packs handle. PHP is a first-class target with a TS-built CLI. What
  reaches a user is not Node at all: the shipped artifact is a single executable with the interpreter
  inside it, so the target machine needs no Node and no npm.
- **Repo layout** (the EmPo repo itself):

```
empo/
  src/
    commands/        init, index, query, verify, check, review, update, doctor, upgrade, pack
    engine/          the language-agnostic graph builder (loads packs, emits graph.json)
    packs/
      php/           pack rules + fixtures + hard-cases.js
      typescript/    pack rules + fixtures
    adapters/
      forge/         github, mcp, local
      tracker/       mcp, github-issues, none
      host-input.ts  the gate: read an agent-fetched payload, check it against git
    discipline/      the shipped review and map markdown + the gate over what comes back
    host/            the AGENTS.md, .claude/ and .codex/ generators, one module per target
    schema/          JSON Schema for config.json, flows.json, spines/*.json, graph.json
  fixtures/          synthetic corpora for pack tests (NO real target code, ever)
```

## The channel: one install script, and nothing else

```sh
curl -fsSL https://raw.githubusercontent.com/W1-PopelierE/EmPo/main/install.sh | sh
empo init
```

**That is the whole of it.** The script installs a standalone binary into
`${EMPO_INSTALL_DIR:-$HOME/.local/bin}` after verifying the checksum the release publishes beside it,
and asks for no `sudo`. Updating is `empo upgrade`. There is no second channel and no fallback
channel: **EmPo is not published to npm, is not a Homebrew formula, and is Unix only for now.** Each
of those is a decision with reasoning below rather than an omission.

One route is the point rather than a limitation accepted reluctantly. Every additional channel is
another set of instructions to keep true, another failure mode to diagnose from a bug report, and
another possible answer to "which empo is on this PATH", which is the question this tool can least
afford to be vague about.

### Why not npm

**EmPo runs inside other people's repositories, so it must not depend on their Node.** That is the
requirement the channel is chosen against, and four things together rule npm out.

- **npm's install location is per interpreter.** `npm prefix -g` returns a different directory for
  every Node version, so a globally installed `empo` leaves PATH the moment the target repository
  switches versions. Measured identical for `npm i -g` and for `npm link`, so the
  linked development setup was never the cause and publishing would not have been the cure. The
  standalone binary fixes the *crash* on a version switch, because it carries its own interpreter. It
  does nothing about the command becoming **unfindable**, and a hook that cannot find its command
  fails open in silence. **A project `devDependency` is the one npm form that answers this**, since
  `node_modules/.bin/empo` is a fixed in-repo path no version switch moves, which is why the cost of
  dropping npm is stated below as the loss of a per-project pin and not waved away.
- **EmPo is language-agnostic and npm is one language's package manager.** EmPo indexes PHP today. A
  Laravel repository has npm because of Vite, which is luck rather than design, and a Go or Python
  repository has no reason to have it at all. Reaching those targets through a JavaScript registry is
  a mismatch that the first non-JS adopter pays for.
- **The npm route needed real machinery, and it had already cost a red CI run.** Shipping a binary
  through npm means per-platform packages gated by `os` and `cpu` behind `optionalDependencies`, plus
  a CommonJS launcher, because a transitive dependency's `bin` is not linked into the top-level
  `node_modules/.bin` (measured against a real `npm install`). The `optionalDependencies` block could
  not be stored in the checked-in `package.json` either: it names packages that have never been
  published, so they are absent from `package-lock.json`, and npm 11 (what Node 24 ships) rejects
  that with `EUSAGE` and `Missing: empo-darwin-arm64@ from lock file` where npm 10 tolerated
  it silently. This repository's own CI went red on exactly that. All of it worked in the end and all
  of it is now deleted.
- **npm is tightening install scripts.** `--allow-scripts`, `--strict-allow-scripts` and
  `--dangerously-allow-all-scripts` appeared in the npm 11 output this repository hit, so the
  neighbouring "npm package that downloads a binary on postinstall" pattern is a closing road rather
  than a fallback to keep in reserve.

**Nothing has ever been published, which is what makes this cheap.** There is no deprecation to
perform, no migration to write and no promise to break: the package `empo` does not exist on the
registry and now will not. That option disappears the moment anything is published once, so choosing
now costs nothing and choosing later costs a deprecation.

**What is given up is real and is not softened here.** A team can no longer pin one agreed version of
EmPo per project through a devDependency, so a repository cannot carry its EmPo version the way it
carries its Vite version, and every developer on that team installs and upgrades on their own. The
`install.sh` answer to it is `EMPO_VERSION`, which pins an exact tag, and that is an instruction in a
README rather than a lockfile entry. The door is not shut forever: **publishing later is always
possible, un-publishing is not**, which is the whole reason the decision goes this way rather than
the other.

Claiming the name on the registry without publishing to it is still worth doing, because a name
nobody holds is a name somebody else can take.

### Why not Homebrew

**Homebrew was considered as the macOS channel and is rejected**, and this is settled rather than
open. It qualifies technically: a formula installs into a prefix that survives a Node version switch,
which is the requirement. It is rejected on adoption, because one route beats three. A formula is a
second install system in front of first contact, on one platform only, and it would have to be kept
in step with every release for the rest of the tool's life. The argument that motivated it was that
`brew install` beats any instruction containing `sudo`, and that argument is answered rather than
dropped: `install.sh` writes into `$HOME/.local/bin`, a directory the user already owns, and never
escalates.

Claude Code does ship a Homebrew cask beside its install script, so a reader comparing the two will
see a difference here. It is deliberate and it is a difference in scale rather than in reasoning: a
second channel is worth its upkeep at that adoption and is not at this one.

### Windows is a known gap, stated rather than discovered

**There is no Windows route.** `install.sh` is POSIX sh, and `empo upgrade` refuses on Windows
outright because a running executable cannot be replaced there, so the rename the upgrade is built on
is unavailable. A Windows user can download a release asset by hand once the releases exist and there
is no supported way to keep it current.

Claude Code ships `install.ps1` and a WinGet package; EmPo ships neither. This is the first thing a
Windows user hits, it is written here rather than left to be discovered, and closing it is a
PowerShell installer plus an upgrade path that swaps the binary from outside the running process.

### What a release carries

A release is cut by CI on every push to main, and the `binaries` job attaches the four platform
assets to it: `empo-darwin-arm64`, `empo-darwin-x64`, `empo-linux-x64` and `empo-linux-arm64`, each
with its `.sha256` beside it. That is what the curl command resolves and what `empo upgrade` checks
against. A checkout plus `npm run build:binary` remains the route for a platform with no published
asset, and it is the only route on anything that is not macOS or Linux.

## The standalone binary

`npm run build:binary` produces `dist-binary/empo` through Node's
single-executable-application support: the building Node is copied, a blob holding the bundle is
injected into it, and the result resolves **no interpreter from the environment it is invoked in**,
which is the whole of the requirement. It has been measured running with zero `node` on PATH, and
inside a repository pinning Node 21 where both documented failure modes, `command not found` and
`TypeError: TEXT_ENCODINGS.union is not a function`, are gone.

**It costs 108MB raw and 34.9MB gzipped, per platform.** That is inherent rather than an oversight:
carrying an interpreter means carrying an interpreter, and the number is stated here so nobody
discovers it in an install log.

**Four platforms are built, and they are declared in exactly one place**, the `binaries` matrix in
`.github/workflows/ci.yml`: darwin-arm64, darwin-x64, linux-x64 and linux-arm64. One list means no
release can declare a platform it did not build. `test/install-script.test.ts` parses those `target:`
values and checks the installer against them, so the script and CI cannot drift into disagreeing
about which machines are supported.

Three things about the build are worth knowing before touching it, because each was a failure before
it was a design.

- **Three assets are compiled in, because a single file has no directory to read from.** The pack
  JSON, the discipline markdown and the version string all reach the running binary through
  `src/embedded.ts`, which is an empty default in a checkout and is replaced wholesale by the binary
  build. The rule is that **a populated `embedded` wins wholesale**, and the disk roots are never
  consulted as a fallback behind it. That is deliberate: a binary installed at `/opt/homebrew/bin`
  has a `../packs` that may well exist and belong to somebody else, and a graph built from a
  stranger's pack rules is exactly the confidently wrong answer this project exists to prevent.
- **The two disk-root computations had to become lazy.** `engine/pack-loader.ts` and
  `discipline/load.ts` each derive a root from `import.meta.url`, which is empty in the CommonJS
  bundle SEA requires, so the eager call threw `ERR_INVALID_ARG_TYPE` before any EmPo code ran at all.
  Computing them on first use means a binary that never asks for a disk root never evaluates one.
- **A dependency's use of `import.meta.url` is not visible from an audit of your own code.** All three
  of EmPo's own uses were made unreachable, and `fdir` (under `tinyglobby`) still called
  `createRequire(import.meta.url)` at module scope. The build defines `import.meta.url` to the
  executable's own file URL for that reason. The reusable half is the shape of the mistake: auditing
  only the code in this repository was not enough, and the thing that broke was in a transitive
  dependency nobody had reason to open.

One shape change came with it. `packDir` inside a `try` in `engine/graph.ts` and `engine/health.ts`
became `packAvailable`, because an exception standing in for a boolean stopped being correct the
moment a build can carry a pack with no directory behind it.

**A binary carrying its packs has no route to an external one.** An earlier revision of this document
said packs may also be separate packages resolved at runtime, so a language could be added without a
core release. That is not available in the shipped artifact: there is no `node_modules` to resolve
from and a populated `embedded` wins wholesale by the rule above. Built-in packs in-tree are the only
form, and adding a language is a release rather than an install. Reopening it means a designed pack
directory with its own integrity check, not a package manager.

`dist/empo.js`, the tsup bundle, stays and is not a channel. It is the fourth of the four
verifications ([14-implementation-notes](14-implementation-notes.md)), because it resolves packs and
discipline markdown from a different root than `src` does. The binary is built from `src/` directly
rather than from `dist/`, so the three resolution paths (source, bundle, compiled-in) are genuinely
three and CI runs all of them.

## The install script

```sh
curl -fsSL https://raw.githubusercontent.com/W1-PopelierE/EmPo/main/install.sh | sh
```

`install.sh` detects the platform and the architecture, resolves the latest GitHub Release, downloads
`empo-<platform>-<arch>` together with its `.sha256`, verifies the checksum, and installs the binary
as `empo` in `${EMPO_INSTALL_DIR:-$HOME/.local/bin}`. `EMPO_VERSION` pins an exact tag instead of the
latest, which is what a team standardizing on one build uses and what a rollback off a bad release
uses.

**A fixed path outside every Node prefix is the property the hooks need**, and it is why this is the
channel rather than a convenience beside one. `~/.local/bin` does not move when nvm switches, so a
`empo` installed there is findable from every repository on the machine whatever that repository
pins.

**It never runs `sudo` and never writes a system prefix.** A default of `$HOME/.local/bin` is a
directory the user already owns, so the install is a write into their own home and nothing else.
Where that directory is not writable the script says so and stops rather than escalating: a script
piped from the network into a shell may not be the thing that decides to become root.

**The checksum is verified here for the same reason `empo upgrade` verifies it**, and the reason is
worth stating once for both. The artifact is an executable that will be placed on PATH under a short
name and then run whenever anybody types `empo`, including from a hook, unattended. A truncated
download and a substituted file both produce something that looks like a binary, and CI publishes the
`.sha256` beside every asset precisely so neither has to be taken on trust. A mismatch aborts with
nothing installed. What it does not defend against is a compromised release host, since the hash
comes down the same channel as the binary; that would need a signature checked against a key that did
not travel with the download, which is not built. [06-cli](06-cli.md) states the same limit beside
`empo upgrade`, because the two share the check and would otherwise share only the reassurance.

**It warns when the install directory is not on PATH and prints the line to add.** That is not
politeness. The failure it prevents is the specific one this whole document is about: an `empo` that
exists on disk and cannot be found is indistinguishable, from a hook's side, from an `empo` that was
never installed, and the hooks fail open in silence either way (see the hooks section below). An
install that finished successfully and left the tool unreachable is the worst of the outcomes here,
because it is the one nobody investigates.

## Upgrading

`empo upgrade` replaces the running standalone binary with the latest release: resolve, compare
versions, verify the sha256, rename the new file over `process.execPath`. `--check` reports without
writing. It refuses on a build that cannot replace itself, meaning the tsup bundle or a checkout,
printing the repair that fits instead, and it refuses on Windows, where a running executable cannot
be replaced. [06-cli](06-cli.md) has the flags, the exit codes and the mechanics of the swap.

**`empo upgrade` and `install.sh` are the only two things in EmPo that reach the network, and that is
a deliberate exception rather than an oversight.** Every other command runs with no network by
design: the graph is built from files on disk, a review reaches a forge only through the user's own
`gh`, and an `mcp` host is fetched by the agent and never by this tool. The exception is scoped as
narrowly as it can be. Both run only on an explicit human command. **Neither is ever invoked during
analysis, from a hook, or as a background update check, and there is no implicit update checking of
any kind anywhere in this tool.** There must never be one. EmPo runs inside private codebases, is
wired into hooks that fire on every edit, and reads source nobody outside the team is meant to see; a
tool that opens a connection while doing that is a different tool, whatever the connection carries.
The way that rule dies is by somebody adding a helpful version ping to a command that already had a
network path available, so the rule is written here rather than left to be inferred from the code.

**Nothing tracks the install, and that is what the single channel costs.** No package manager knows
EmPo is there, so nothing lists it beside the machine's other tools, nothing removes it but `rm`, and
being out of date is only visible to somebody who runs `empo upgrade --check`. That is the price of a
path no interpreter owns, and it is paid deliberately.

## The interim shim, and how to remove it

**Releases now carry the binary, so this section is a teardown rather than a plan.** A shim was the
correct interim answer while there was no artifact to point at; there is one now, and the moment a
machine has an installed `empo` the shim is not interim any more, it is a stale checkout shadowing an
installed tool.

Until the binary reaches a target, one below the floor is wired by pointing PATH at a shim that picks
a Node meeting EmPo's floor instead of the one the target pins. The shape:

```sh
#!/bin/sh
# Fail open and stay silent if anything is unresolvable, exactly as the hooks do.
EMPO_JS="/absolute/path/to/empo/dist/empo.js"
[ -r "$EMPO_JS" ] || exit 0
# Accept the interpreter on PATH ONLY if it clears >=22.12.0, then fall back to a
# known install. In a target pinned below the floor, PATH is the wrong answer.
...
exec "$NODE" "$EMPO_JS" "$@"
```

Install it as `empo` in a directory that is on PATH without a version switch moving it, and prefer a
user-writable one: the directory the host binary itself lives in is a good default, and no
instruction here should ever require `sudo` to write into a system prefix.

**Delete the shim when the binary ships, and treat that as part of the release rather than as
cleanup.** A shim names an absolute path to one checkout. Left in place after a real binary is
installed it keeps resolving to that checkout, shadows the installed command, and answers every
query from whatever that working tree happened to contain. A stale graph tool that answers
confidently is the single failure this project exists to prevent, so the teardown is two steps and
both are required: remove the shim from PATH, then confirm with `command -v empo` that the path it
prints is the installed binary and not the shim.

`install.sh` sharpens that rather than solving it. Its default target is `$HOME/.local/bin`, which is
where a hand-built binary is likely to already sit, so the first real run overwrites that file and
leaves nothing stale at that path. A shim installed anywhere else survives, and whichever of the two
sorts earlier on PATH wins with nothing saying which. So the second step is the one that matters: run
`command -v empo` and read the path.


## The instruction file (`AGENTS.md`)

The first host target, and the one every agent host reads. `empo init` writes it and `empo update`
regenerates it, from this project's config rather than from a static template, because the useful
half of these instructions is what *this* repository looks like: which directory is which language,
which forge and tracker it really has, and therefore what a review can and cannot know. A
hand-written file says "configure a tracker"; a generated one says there is none, so ticket-fit
grading is skipped, do not invent criteria.

**EmPo owns a block, not the file.** Everything between `<!-- empo:begin -->` and `<!-- empo:end -->`
is replaced on the next run and everything outside them is the repository's. A file with no markers
is appended to, never replaced, so an `AGENTS.md` a human wrote survives its first `empo init`, and
every run after that finds the markers it wrote. Anything other than exactly one pair in order is
refused rather than guessed at, because both silent answers are wrong: replacing the first pair
leaves a stale second copy of the instructions the block exists to keep current, and replacing
everything from the first marker to the last deletes whatever a human wrote between the pairs. A
byte-identical merge is reported `unchanged` and the file is not written.

The block names the roots and their languages, which of `.empo/` is human-owned, the forge and the
tracker with what degrades when either is absent, the command table, and the two rules an agent must
not get wrong: `.empo/generated/` is machine-owned, and a guarded file needs a value-asserting test.
It deliberately does **not** carry the review discipline. It says that `empo review` prints the
discipline and that the agent runs what it prints, because the copy the command hands over is the one
the verification gate is built around and a second copy would drift from it.

This is the OpenSpec-parity artifact and is what makes EmPo work on the "25+ tools" without a bespoke
integration each.

## The `.claude/` configuration

The Claude host target, and the one an instruction file cannot replace: an instruction is advice, a
hook is a gate. `empo init` writes it, `empo update` regenerates it, and `--no-host` skips it exactly
as it skips the other host artifacts.

**It is not a plugin, and that is a correction to this document.** An earlier version of this section
specified a Claude Code plugin with `/empo:query` and `/empo:review`. The colon is a *plugin*
namespace, and the plugin form was checked against the current Claude Code documentation and cannot
deliver the thing this section exists for:

- A file under `.claude/commands/` becomes a command named after the file, with no extension and no
  subdirectory namespace: `.claude/commands/deploy.md` is `/deploy` and never `/some:deploy`.
- A skill at `.claude/skills/<name>/SKILL.md` is `/<name>`. Nested `.claude/skills/` directories
  below the working directory namespace by directory path, which is not a prefix a generator gets
  to choose.
- Only a plugin gives `/plugin-name:command-name`, and a plugin needs a marketplace plus a per
  developer install. A project's `.claude/settings.json` can carry `extraKnownMarketplaces` and
  `enabledPlugins`, but that only **prompts** each teammate to install, and an external-source plugin
  does not load until they do.

So the plugin buys a prettier name and costs the only thing that mattered: hooks that fire for
everyone who cloned the repository, without anyone remembering them. EmPo generates standalone
`.claude/` configuration instead, and takes the hyphen: `/empo-query`, `/empo-review`, `/empo-map`.

```
.claude/
  skills/
    empo-query/SKILL.md     generated whole, EmPo owns the file
    empo-review/SKILL.md    generated whole, EmPo owns the file
    empo-map/SKILL.md       generated whole, EmPo owns the file
  settings.json             merged into, never replaced
```

The three skill files are EmPo's own, because they live in directories named `empo-*` that nothing
else writes, and each opens with a notice saying it is replaced on the next run so nobody hand-edits
one and loses it. They are generated from `discipline/` plus this project's config, the rule
`AGENTS.md` already follows, so they name this repository's roots, forge and tracker. `empo-query`
stays model-invocable, because asking the graph before guessing at consumers is exactly the thing
worth firing without anyone typing it; `empo-review` and `empo-map` are user-invoked only, because a
review and a remapping of somebody's product are deliberate acts. Neither of those two restates the
discipline its command prints, for the reason the `AGENTS.md` block does not either: the copy the
command hands over is the one the verification gate is built around, and a second copy drifts.

### `settings.json` is the repository's

It is where a team keeps its permissions, its environment and its own hooks, none of which is
reproducible from a file listing, so EmPo merges into it and removes only what it can prove is its
own. There is no marker-comment trick available in JSON, so ownership is by content:

> An entry inside a `hooks` array is EmPo's if and only if its `type` is `"command"` and its
> `command` string invokes `empo hook `, whether as the bare command or through a path ending in
> `/empo`.

That second clause exists because the wiring gained a second spelling when the binary landed, and a
rule that recognized only the bare command would have left the old entry unclaimed beside the new one
rather than replacing it. The section on the three hooks below states the trap in full; it is repeated
here because this is the paragraph somebody edits when they add a third spelling.

Regenerating means: parse, drop every entry matching that rule wherever it appears, insert the
current entries under the right events, drop a matcher group and then an event that the removal left
empty, and leave every other key in the document exactly where it was. EmPo appends its own group
rather than joining one whose matcher happens to look the same, because a team's `Edit|Write` group
is theirs and two groups on one event both fire.

Four rules govern the merge. Three make it safe and the fourth states what it costs.

- **Refuse rather than guess.** A `settings.json` that is not parseable JSON, or whose `hooks` is not
  an object, or one of whose events is not an array, is refused with a config error naming the file
  and what to fix, exactly as a malformed marker pair in `AGENTS.md` is refused. Nothing is written
  at all, the three skill files and `AGENTS.md` included, because a generator that fails halfway
  leaves a repository configured neither way. That is also why this target is written before the
  other one. Never rewrite a file you could not read: the alternative is starting from `{}` and
  silently deleting a team's permissions.
- **Compare parsed, not printed.** Whether anything changed is decided by deep equality of the parsed
  document before and after, never by string comparison. A file that is already correct but indented
  with four spaces, or whose keys sit in another order, is semantically identical, is reported
  `unchanged`, and is left byte for byte as it arrived. Otherwise `empo update` would reformat a file
  it had no change to make, on every run.
- **A real change reprints the document.** When there is something to write, the whole file is
  serialized as two-space JSON and the formatting everywhere else in it is normalized. That is a real
  cost of merging into somebody's file and it is stated rather than left to be discovered in a diff.
- **Say what was taken out and not put back.** Ownership by content cannot tell an entry EmPo wrote
  from one a human wrote that looks like EmPo's, and that is the known weakness of a rule with no
  marker available: an `empo hook` entry somebody wired by hand, on another event or with another
  timeout, is removed on the next update and not restored. That much is unfixable here. What is
  fixable is the silence, so every entry the merge removes is compared against the regenerated
  output under the same event and the same matcher, and anything that does not come back verbatim is
  named by `empo init` and `empo update` as a note, with the event, the matcher and the command
  string, so it can be put back somewhere EmPo does not recognize. On an ordinary run the list is
  empty, which is what keeps it worth reading when it is not: a hook a human wired by hand should
  not disappear inside a diff that looks like a routine regenerate.

### The three hooks

Each is one entry in `settings.json` calling `empo hook <event>` ([06-cli](06-cli.md)), with
`${CLAUDE_PROJECT_DIR}` expanded by the host so a hook resolves the repository it was configured for
and not whatever directory the session sits in, and with a `timeout` in seconds.

- **SessionStart** runs `empo hook session-start`: a graph that is on disk and cannot be read at all,
  a graph that is behind HEAD, each pack whose installed version is not the one the graph was built
  from, a spine that has drifted, and any health finding under it, such as a root or a pack the
  config names and the repository does not have, or a spine file that will not parse. The first three
  are named on their own because none of them arrives as a finding. An unreadable graph is a state
  with no finding attached and `ok` left true, which is honest of each part and reads as healthy
  together, and it is the one state worth opening a session with, because every graph-derived answer
  is then unavailable rather than merely out of date. Pack drift is a field on the graph's health and
  not a fault in the repository, and git distance cannot see it: the graph can sit exactly at HEAD and
  still be answering out of a pack nobody has installed any more. All three share one repair, so the
  hook prints the reasons it found and then says `empo index` once at the end of them rather than
  after each. It says nothing at all when there is nothing wrong, and nothing in a repository whose
  config it cannot read at all, because a hook that reports good news every session is one nobody
  reads by the third day.
- **PreToolUse on `Edit|Write`** runs `empo hook pre-edit`: it denies any write whose path resolves
  under `.empo/generated/`, which is [02-on-disk-layout](02-on-disk-layout.md)'s rule turned from
  prose into a gate, and warns without blocking when the path is on a spine's `guarded` chain, so the
  agent reads the spine before it changes a value there. The warning carries no permission decision
  at all, so an ordinary edit is never prompted for or blocked by it.
- **PreToolUse on `Bash`** runs `empo hook pre-commit`: it recognizes a git commit and denies one
  that touches a spine's guarded files with no added value-asserting test, from the same computation
  `empo check` prints, naming the spine, the files and the terms it wanted. Bypassable only by
  explicit human decision with a reason on the record, never by unstaging the spine file.

**The hooks fail open.** A machine with no `empo` on its PATH exits 127, which the host treats as
"other", which is non-blocking for every event. That is deliberate: a gate that blocks every edit on
a machine where the tool is absent is a gate that gets deleted within a day, and a deleted gate
catches nothing at all. The cost is that an uninstalled CLI looks exactly like a clean repository
from the host's side, which is why `empo check` in CI is still the gate that has to hold.

**Do not read that exit 127 as "the CLI is not installed."** It is the same exit code for a CLI that
is installed, current and simply unreachable from this repository, which is what a target pinning a
Node below the `engines` floor produced on every event, for the reason the channel section above
records. The two cases are indistinguishable from the host's side and they call for opposite
responses, and the developer's own check cannot tell them apart either: `empo --version` runs in an
interactive shell, which is the one environment where the second never appears. So a target below the
floor reported health while three hooks failed open on every event.

**The binary removes that second case and the report-level fixes it argued for are still worth
having.** A hook pointed at a binary carrying its own interpreter cannot fail for the target's Node
version, so the ambiguity collapses back to the honest one. What it does not cover is the first
failure: an `empo` that was installed into a directory the user never put on PATH is unfindable, and
nothing detects that either. So `empo doctor` executing each wired hook the way the host runs it
remains open and remains the cheaper of the two fixes, and until it exists the honest statement is
unchanged: the hooks are silent about their own absence, and CI is not a mitigation for a developer
who has not wired one. `install.sh` warning about PATH is the mitigation that exists, and it only
covers the machine that ran the script.

**The wiring is target-dependent, which is now a leftover rather than a route.** Where the target has
a `${CLAUDE_PROJECT_DIR}/node_modules/.bin/empo`, the generator writes that in-repo path; where it
does not, the entry is the bare `empo hook ...`. With npm dropped as a channel nothing puts an EmPo
there any more, so in practice every wired entry is the bare command, and the local-path branch
survives because it is harmless and because a repository wired before this change still carries one.
One trap comes with it and it is the kind that produces a mess rather than an error. **`empo update`
identifies
its own hook entries by their command string** (`settings.json` is the repository's, above: ownership
is by content, an entry whose `command` starts with `empo hook `). Widening what the generator
**writes** without widening what it **recognizes** does not fix a wired repository, it doubles it: the
old entry is not claimed, so it is not removed, and the new one is appended beside it. Both then fire
on every event. The two halves are one change and must never be split across two.

The wiring is optional, which is what makes its absence survivable. Without it a developer still runs
`empo query`, `empo review` and `empo check` from the terminal and CI, and every agent host that
reads `AGENTS.md` gets the instructions above. What it adds is the manual steps removed, and three
hooks that turn a rule stated in a file into something that fires while an agent works. It holds no
knowledge of its own.

## The `.codex/` configuration

Codex receives the same repository-local workflows without a plugin or marketplace installation.
`empo init` writes the skill files for a new project and `empo update` regenerates them from that
project's config:

```sh
.codex/
  skills/
    empo-query/SKILL.md     generated whole, EmPo owns the file
    empo-review/SKILL.md    generated whole, EmPo owns the file
    empo-map/SKILL.md       generated whole, EmPo owns the file
```

Like their Claude counterparts, these files are generated from `discipline/` plus the project config
and must not be hand-edited. `AGENTS.md` provides the shared repository instructions for both hosts.
Codex has no generated equivalent of Claude's `settings.json` hooks: it receives the skills and
instructions, while `empo check` in CI remains the enforcement mechanism that applies to every host.
`--no-host` skips this tree together with the `AGENTS.md` and Claude targets.

## Host integration is generated, not hand-written per host

`empo update` regenerates every host artifact from one source (`discipline/` + config). Today that is
three targets: `AGENTS.md`, `.claude/` and `.codex/`. The shared instruction file and both host skill
trees carry the same EmPo workflows. Claude additionally has automatic hooks through
`.claude/settings.json`; Codex has no generated hook configuration. Supporting a new agent host is a
new generator target, not a rewrite of the discipline, and not a branch inside an existing generator.
This is exactly why OpenSpec can claim many supported tools: the instructions are generated, so
breadth is cheap.

## CI usage

The mechanical commands are built to gate CI without an agent:

```yaml
# illustrative
- empo index --check      # fail if the committed graph is stale (if graph is committed)
- empo verify             # fail on spine drift
- empo check --base $BASE # fail a spine change with no value assertion
```

`empo review` is deliberately **not** a CI gate. A review reports and advises; it does not block a
merge on a judgement call. Only the mechanical gates return non-zero. This keeps the LLM out of the
merge-blocking path, which matters for trust and for cost.

**This repository now runs that CI on itself**, in `.github/workflows/ci.yml`, and it was the first
workflow here: several pages of these docs had said "`empo check` in CI is the gate that has to
hold" while no CI existed to hold it. The `verify` job runs the four verifications
([14-implementation-notes](14-implementation-notes.md)) on Node 22 and Node 24, then runs the built
bundle, because `engine/pack-loader.ts` and `discipline/load.ts` each probe a different root under
`dist/` than under `src/` and a green suite says nothing about either. A `binary` job runs beside it
for the third resolution path, the compiled-in assets, on the same reasoning one clause on: a bundle
that reads a pack off disk says nothing about a binary that carries one. `empo index` followed by
`empo index --check` is the determinism requirement measured rather than asserted: two builds of one
tree, compared byte for byte. `empo check --base` runs on pull requests only, and guards nothing
here yet, because `.empo/spines/` holds only `.gitkeep`.

## Versioning

- The CLI, the packs, and the graph schema each carry a version. `packs.lock.json` records which
  pack versions built the current graph so a graph is reproducible.
- **The CLI's own version moves on a merge to main and nowhere else.** It sat at `0.0.0` from the
  first commit, which is the placeholder npm writes rather than a claim about
  anything, and it stayed there because this section had rules for the packs, the graph schema and
  the config and none for the thing the package is. The rules are below.
- `config.json` has a top-level `version`; `empo update` migrates it forward when the schema changes.
- Breaking a pack's rule vocabulary is a major bump and forces an `empo index`; the staleness line
  makes that visible rather than silent.
- **Changing what a pack extracts, without changing what its rules may say, is a minor bump.** Adding
  entries to `assertionTerms` or `assertionExcludes` is the ordinary case: the schema is untouched and
  every config that loaded before still loads, so nothing is broken, but the verdicts move over real
  source and a graph built by the old pack now answers a question the new one answers differently.
  That is not a judgement call to be made again per change. A pack version is the only thing that can
  carry the news: `packs.lock.json`, the drift line in `empo doctor` and the SessionStart hook all
  compare the version the graph recorded against the version installed, so a data change that leaves
  the version where it was is a change nothing downstream can see, and the reindex it needs is one
  nobody is told to run.
- **That last rule is pinned mechanically, because remembering it did not work.**
  `test/packs/versions.test.ts` hashes every installed pack's parsed fields and records the hash
  beside the version it was true of, so an edit that changes what a pack means and leaves the version
  alone fails the suite and is told what goes silent if it does not bump. It hashes the parse rather
  than the file, so reformatting `pack.json` costs nothing and a field the schema does not declare
  cannot demand a bump. Two packs were found carrying unversioned behaviour changes when it landed,
  which is the measurement that says the rule above needed a machine rather than a paragraph. One of
  those two is deliberately still unbumped: `resolvedBy` and `arrivedBy` are read off the pack at
  answer time and never enter a graph, so no graph can go stale on them.

### The CLI version: what moves it, and what does not

`package.json`'s `version` is the whole answer to "which build is this". `src/program.ts` reads it
through `createRequire` and hands it to commander, so `empo --version` is that string and never a
second copy of it. It reaches no other surface: `graph.json` records the **pack** versions and the
graph schema and not the CLI's, which is why bumping this number cannot make a graph stale, cannot
move a byte of `graph.json`, and cannot fail `empo index --check`. That independence is worth
keeping deliberately. A release number that entered the graph would make every release a reindex.

The rules:

- **A merge to main is a version bump.** `.github/workflows/ci.yml`'s `release` job runs after
  `verify` is green, bumps `package.json` and `package-lock.json` with `npm version`, commits
  `Release vX.Y.Z [skip ci]`, pushes an annotated `vX.Y.Z` tag, and cuts a GitHub Release with
  generated notes. A `binaries` job then builds the standalone binary per platform and attaches each
  as a release asset, so a release carries the artifact the hooks point at rather than only a tag.
  Nothing is published to npm, and `package.json` carries `"private": true` so `npm publish` refuses
  rather than relying on nobody typing it. The release assets are the whole of what a release
  delivers, which is why the `binaries` job is not optional decoration on it.
- **Patch is the default and the label is the only way to say otherwise.** A merged pull request
  labelled `bump:major` or `bump:minor` gets that instead; `bump:patch` says the default out loud;
  `bump:skip` cuts no version at all. A push straight to main names no pull request, carries no
  labels, and bumps patch.
- **The signal is a label rather than the commit message, and that is a constraint this repository
  chose earlier.** Commit messages here are one-line prose with no `feat:` or `fix:` prefix, so a
  conventional-commit release tool would classify every commit as "no release" and the version would
  never move. Changing the commit convention to feed a release tool would be the tail wagging the
  dog. A label also sits on the pull request while it is open, which is when the size of the change
  is actually being discussed.
- **Pre-1.0 while the surface still moves.** It starts at `0.1.0`, not `1.0.0` and not `0.0.1`:
  under semver a `0.x` minor is where a breaking change goes, which is honest about a CLI whose
  flags are still being added, and `0.1.0` leaves the patch digit free for the first automated bump
  to use. `1.0.0` is the publish decision, not this one.
- **`test/program.test.ts` is the pin.** It asserts that what commander reports is what
  `package.json` declares, that the string is semver so a tag can be named after it, and that it is
  not `0.0.0` again. No unit test can exercise a GitHub workflow, so what it pins is the state the
  workflow exists to end.

Two costs, stated rather than left to be discovered:

- **A protected `main` that requires a pull request will reject the bot's push**, and the release
  job fails on the `git push` with nothing released. The fix is a branch-protection allowance for
  the `github-actions[bot]` actor, or a personal access token in place of `GITHUB_TOKEN`. Note that
  the second one removes GitHub's own recursion guard, which is why the release commit carries
  `[skip ci]` even though the token used today makes it unnecessary.
- **Two merges landing within a minute share a version.** The release job is serialized on a
  `release` concurrency group, and GitHub keeps only one *pending* run per group, so a third merge
  arriving while one is queued drops the queued one. No commit goes unreleased, because the tag is
  cut against the tip of main and therefore contains both, but that merge does not get a number of
  its own. Fixing it properly means a fetch-rebase-retry loop around the push, and it is not worth
  the machinery at this repository's merge rate.
