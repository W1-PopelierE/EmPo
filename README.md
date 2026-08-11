# EmPo

**EmPo tells you which end-user flows a code change can reach, and whether any test would notice if
the change is wrong.**

It is a command-line tool for large, multi-language codebases, built for the case where a human or
an AI coding agent is about to edit shared code and nobody holds the consumer list in their head. It
is language-agnostic and monorepo-native, including the coupling that crosses a language boundary.

## What it looks like

Real output from the synthetic `acme-platform` fixture in this repository, with two lines cut for
length. You are about to change a pricing class and you want to know what that can reach.

```
$ empo query PriceCalculator

symbol     Acme\Libraries\Price\PriceCalculator
file       apps/api/app/Libraries/Price/PriceCalculator.php
kind       class (php, root apps/api)
fan-in     3 direct, 8 transitive (the direct ones included)

flows reached
  checkout  BLIND  1 test reaches it, none asserts a value
            via apps/api/app/Http/Controllers/CheckoutController.php (1 of 1 node reached)
  orders    covered  3 tests reach it, at least one asserts a value
            via apps/api/app/Http/Controllers/OrderController.php (4 of 8 nodes reached)

top consumers
     2  Acme\Http\Controllers\CheckoutController  apps/api/app/Http/Controllers/CheckoutController.php:5
     1  Acme\Http\Controllers\OrderController     apps/api/app/Http/Controllers/OrderController.php:5

cross-language reach
  http-route  apps/mobile/src/api/client.ts
              consumes apps/api/routes/api.php  named at apps/mobile/src/api/client.ts:2

names      hook     2 of 2 resolved
names      template 1 of 1 resolved

Treat the flow list as a floor, not a ceiling. Absence of evidence is not evidence of absence.
```

Every claim carries a citation down to the line, so an agent repeating it can be checked rather than
believed. `BLIND` is the answer coverage tools do not give: a test does reach checkout, so the line
counts as covered, but nothing on that path asserts a value, and changing the rounding leaves the
suite green.

The cross-language edge is not an import. The mobile client names a route string the PHP backend
produces, which no import parser on either side can see.

The `names` lines are the answer's own yield: a component tag or a Blade `<x-...>` names a file by a
bare name, and where that name is carried by two files or by none, no edge is written. Both counts
print with their denominator, so a blast radius standing on rules that resolved almost nothing says
so instead of reading like a complete one. Measured on a real React Native application, that family
resolved 3 of 1531 tag references before the fix that shipped with this line, and nothing on the
answer said it.

And the closing line is the contract, not modesty: reflection and dynamic dispatch add reach no
static graph can see.

## Quick start

```sh
empo init      # detect languages, scaffold .empo/, generate agent-host wiring
empo index     # build .empo/generated/graph.json from source
empo query PriceCalculator
```

`empo index` is the only command that writes the graph, and nothing under `.empo/generated/` is
meant to be hand-edited. Everything else in `.empo/` is yours.

`empo init` and `empo update` generate repository-local agent support. Both Claude Code and Codex
receive the shared `AGENTS.md` instructions and the three `empo-*` skills. Claude additionally
receives its automatic hooks through `.claude/settings.json`; Codex has no equivalent generated hook
configuration, so `empo check` in CI remains the enforcement gate.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/W1-PopelierE/EmPo/main/install.sh | sh
```

That is the intended channel. It installs a standalone binary carrying its own Node into
`~/.local/bin` (override with `EMPO_INSTALL_DIR`, pin a tag with `EMPO_VERSION`), after checking it
against the sha256 the release publishes. It never asks for `sudo`. Upgrade with `empo upgrade`, or
look first with `empo upgrade --check`.

Every release carries four binaries, `empo-darwin-arm64`, `empo-darwin-x64`, `empo-linux-x64` and
`empo-linux-arm64`, each with its `.sha256` beside it. To build from source instead:

```sh
npm install && npm run build:binary   # produces dist-binary/empo
```

**macOS and Linux only.** `install.sh` is POSIX sh and `empo upgrade` cannot replace a running
executable on Windows, so there is no Windows route. EmPo is not on npm and is not a Homebrew
formula, deliberately: it runs from hooks inside other people's repositories, so it must not live at
a path a language toolchain can move out from under it.
[`docs/10-distribution.md`](docs/10-distribution.md) has the reasoning and what it costs.

`empo upgrade` and `install.sh` are the only two things here that touch the network, and only when a
human runs them. Nothing that reads your code makes a request, and EmPo never checks for updates on
its own.

## What it does

EmPo builds a dependency graph and models three levels of coupling: ordinary import edges inside one
language, *string* edges across languages where a route path the backend produces meets the path the
frontend consumes, and flows, the end-user journeys that may cross roots entirely.

On top of that graph:

- **`empo query`** answers blast radius, including the blind-flow answer above and, with
  `--hazards`, a queued job dispatched inside a database transaction before the commit, where a
  worker can pick the job up before the rows it needs exist.
- **`empo review`** runs a two-phase verification gate. It prints facts plus the shipped review
  discipline, an agent writes findings, and `--findings` resolves every citation against real source
  and prints only the survivors. A claim standing on text that does not exist is dropped.
- **`empo verify` and `empo check`** hold hand-curated critical chains, and `empo hook` makes those
  fire while an agent works rather than only when somebody types them.

Two rules run through all of it. **Never guess the consumer list, query it**: impact comes from a
generated graph, not from a document somebody wrote and forgot to update. And **an assertion is not
true because the code ran, it is true because something checked it**. Import graphers already exist
(madge, deptrac, dependency-cruiser, knip); what EmPo adds is coupling the graph to end-user flows
and test coverage, and refusing to let an agent write a finding it did not verify.

## Documentation

The design corpus under [`docs/`](docs/) is the source of truth for this project, ahead of the code.
Start here:

- [00-overview](docs/00-overview.md), the problem, the principles and the positioning
- [01-architecture](docs/01-architecture.md), the four layers and the three coupling levels
- [03-config-schema](docs/03-config-schema.md), `.empo/config.json`: roots, bridges, adapters, packs
- [04-language-packs](docs/04-language-packs.md), the contract that makes EmPo language-agnostic
- [06-cli](docs/06-cli.md), every command, its flags, its exit codes and its output

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

Treat any answer EmPo gives as a floor and not a ceiling.
