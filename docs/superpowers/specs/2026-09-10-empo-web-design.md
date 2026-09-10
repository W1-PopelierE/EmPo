# `empo web` — a local viewer for a review in progress

Status: design, approved in brainstorming. Not yet planned or implemented.

## The problem

`empo review` is two phases and the interesting part of it is invisible. Phase 1 prints a brief and
returns. The agent then reads source for some minutes, writes `findings.json`, and phase 2 prints
the survivors. What you see in the terminal is the beginning and the end. In between there is no
answer to "what is it doing", and at the end there is no answer to "what did it drop, and why", or
"which changed file did it never open".

Everything needed to answer those already lands on disk. Nothing reads it.

## What this is

`empo web`, a long-running command you start in your own terminal, which serves a page on
`127.0.0.1` showing the review as it happens: the diff, which files the reviewer is reading right
now, the findings as they appear, and what the gate kept and dropped.

It is a viewer. It is read-only, it is local, and it is one person's window on their own machine.
Acting on findings from the browser is explicitly out of scope for this version — see
[Deliberately out of scope](#deliberately-out-of-scope).

## Constraints this design accepts

- **`empo review` does not change.** Not one line. It already writes what the viewer needs, and its
  teardown invariant (a review disturbs nothing in the checkout it reads) stays intact.
- **No new dependencies.** `node:http` and the standard library. No framework, no bundler, no CDN.
  The page is one embedded HTML string with inline CSS and vanilla JS.
- **Nothing is reported by the agent.** Every phase is derived from files on disk, so nothing in the
  display depends on an agent being honest about its own progress.

## Data sources

| source | gives | lifetime |
|---|---|---|
| `<tmpdir>/empo-review/<key>/session.json` | base, branch, sha, `readRoot`, `diffPath` | until the gate |
| `<tmpdir>/empo-review/<key>/pr-<id>.diff` | the diff to render | until the gate |
| `<tmpdir>/empo-review/<key>/findings.json` | suspected findings with claim, citation, suggestion | until the gate |
| round record under `roundsRoot()` | which findings survived the gate | permanent |
| activity JSONL (new, see below) | which file the reviewer is reading | during the review |

`<key>` is `pathKey(id, canonicalRoot(repoRoot))`, the same key `sessionDir` uses
(`src/commands/review.ts:2217`).

**The session directory is deleted by the gate** (`src/commands/review.ts:1943`). The viewer must
therefore have read the diff and `findings.json` before that happens, and keep them in memory. This
is a design constraint, not a bug to fix: the alternative — making review preserve state for a
viewer — puts a UI's needs inside the discipline's lifecycle.

**Survivors need both sources.** The round record stores only `id/kind/severity/title/file/line`
(`src/engine/rounds.ts:87`), which is too thin to display. Crossing it with the `findings.json` read
earlier gives survivors with their full text, and — the part the terminal never shows — the dropped
findings alongside them.

## The new hook event

`empo hook tool-use`, a `PostToolUse` hook with matcher `Read|Grep|Glob|Edit|Write`, added to
`empoHooks()` (`src/host/claude.ts:162`) so `empo init` and `empo update` wire it like the other
three. It appends one JSONL line per tool call: timestamp, tool, path, session id.

Two rules keep it honest, both inherited from the existing hook invariants
(`src/commands/hook.ts:18-45`):

- **Silent outside a review.** If no session directory exists for this repo, it writes nothing. Your
  ordinary work never lands in a log.
- **Never fails.** Exit 0 always, no output to the agent.

The log is truncated by the hook above 1 MB. The server keeps the last 200 lines whose timestamp is
after the current session's start.

Codex gets nothing here: `writeCodex` ships skills only and has no hook mechanism
(`src/host/codex.ts`). The viewer works under Codex too, minus the live tool stream.

## The server

`src/commands/web.ts`. Three routes:

| route | serves |
|---|---|
| `GET /` | the embedded HTML page |
| `GET /api/state` | the full snapshot as JSON |
| `GET /events` | SSE; pushes a fresh snapshot on every change |

**Polling, not `fs.watch`.** One loop at ~400 ms over a handful of known paths. `fs.watch` on macOS
misses newly created subdirectories and duplicates events; a few `stat` calls per tick cost less
than working around that. Marked in source as `// ponytail: polling, revisit if it shows up in a
profile`.

**Whole snapshots, not patches.** A review diff is kilobytes. Recomputing and resending is less code
than diffing, and a browser refresh is then correct by construction.

**Phases are derived**, never announced: `session.json` exists → brief ready; activity lines arrive →
reading; `findings.json` appears → findings written; a new round record → gate ran.

The diff is parsed with the existing `parseDiff` (`src/engine/diff.ts`); the server sends hunks as
JSON and the client renders them.

## Security

The server exposes source code and diffs from a private machine. Three rules, none of them optional:

> **Amendment, 2026-09-10, before merge.** Rule 2 no longer describes what ships. The `GET /file`
> route this spec's security rules were written around was deleted before merge: the page renders
> every changed line out of the snapshot's parsed hunks, so nothing consumed it, and it was the only
> route that ever streamed file bytes off the listener. Deleting it removes the containment check
> along with the thing it contained. The control that shipped in its place, and that this document
> predates, is a `Host`-header check: anything but loopback is refused, which is what closes DNS
> rebinding against a listener bound to `127.0.0.1`. Rules 1 and 3 stand as written. See
> `docs/11-security-boundaries.md` for the surface as shipped.


1. **Bind `127.0.0.1` only.** Never `0.0.0.0`, and no flag to change it.
2. **File content comes only from the active session's `readRoot`**, with a containment check on the
   resolved path. A request for `../../.ssh/id_rsa` is refused, not normalized.
3. **No write routes.** The viewer has no way to change anything, in this version by design and not
   by omission.

`docs/11-security-boundaries.md` gains a short section on the viewer's runtime surface; today that
document is about what the repository ships, and this is the first runtime listener EmPo has.

## The screen

Two columns, deliberately plain:

- **Left:** changed files with their finding counts; **unread** changed files marked as such; below
  them the files read *outside* the diff (the blast radius the reviewer actually checked); below
  that the live tool stream.
- **Right:** the selected file's diff with findings as markers on their line; underneath, the
  findings list showing survivors and dropped findings together.

The three things this shows that the terminal cannot: changed files the reviewer never opened, what
it read beyond the diff, and what the gate dropped.

No syntax highlighting, no word-level diff highlighting in this version.

> **Amendment, 2026-09-10, before merge.** Three sentences above are not what shipped.
>
> **Context lines.** `ChangedHunk` gained `context: ContextLine[]` (`{oldLine, newLine, text}`);
> `added` and `removed` are untouched, so `changedLines` and the findings gate read exactly what they
> always read. The page rebuilds the hunk in git's order out of the three arrays (`hunkRows`,
> `src/web/render.ts`) and renders context dimmed, every row carrying an old *and* a new number
> column — so one column no longer holds numbers from two revisions.
>
> **Syntax highlighting**, listed here as out of scope, shipped: a hand-written ~15-line tokeniser in
> `src/web/render.ts` (strings, comments, numbers, keywords), no dependency and no CDN. It runs
> *after* `esc()` and only ever wraps spans around already-escaped text; that ordering is the page's
> whole XSS argument, because tokenising first would escape the spans and leave a diff's own
> `</script>` live. It is skipped entirely for extensions it does not recognise as code, so a
> markdown diff is not coloured, and it is single-line and stateless: an unterminated block comment
> colours to the end of that line and no further.
>
> **The marker is inverted.** The left column marks the files that *have* been read, with a `✓`
> glyph rather than colour alone. Before the reviewer opens its first file every changed file is
> unread, so the marker this spec asked for marked every row and distinguished nothing. The signal
> this section wanted — changed files the reviewer never opened — is still readable, as the absence
> of a check; but only as an absence. The mark is the `tool-use` hook's log and nothing else, and
> that hook's matcher is `Read` alone (`src/host/claude.ts:171`), so a file reached by `Grep` or
> edited without being opened stays unmarked — and under Codex, which has no hooks, no file is ever
> marked at all.

## Edge cases

| case | behavior |
|---|---|
| no review running | idle screen; the server keeps running and picks up the next one |
| several repos | `empo web` is per repo (`--repo`). Two repos, two processes, two ports |
| port taken | default `7373`, increment until free, print the address. `--port` pins it |
| two sessions in one repo (PR + local) | newest wins, with a "2 sessions active" line. No switcher in this version |
| abandoned session directory | shown with its mtime and nothing more; cleanup is review's job |
| teardown deletes the directory mid-read | every read in try/catch; a vanished source leaves the last known state standing, marked "session finished" |

## Testing

Three pieces, in the existing vitest layout (`test/commands/*.test.ts`):

1. **State derivation** — the only non-trivial logic. A fixture directory with a fake `session.json`,
   diff, `findings.json`, round record and activity JSONL; assert the phases, the unread changed
   files, the read-outside-the-diff list, and the survivors × dropped crossing. Plus the empty
   variants: no session, session without findings, round record with no matching findings file.
2. **The hook** — `empo hook tool-use` with a stdin payload: writes a line with an active session
   directory, silent without one, exit 0 either way.
3. **The server** — starts on port 0; `GET /api/state` returns the snapshot; one path-traversal
   request is refused.

Not tested: HTML/CSS rendering and SSE timing. Those are checked by eye and their tests break on
every UI tweak.

## Deliberately out of scope

- **Acting on findings from the browser** ("not a problem", "fix this with TDD", "file a ticket").
  The intended shape when it comes: the page writes a decisions file the agent reads after the gate.
  Not built until the viewer is actually in daily use.
- **Sharing or hosting.** Local, single user.
- **Multi-repo dashboard**, session switcher, history browser across rounds.
- **A prettier diff viewer.** The value is in seeing the review, not in the viewer.
