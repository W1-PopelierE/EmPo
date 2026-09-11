/**
 * The page, as one string. No build step, no bundle, no CDN: the binary is offline by the time a
 * reader runs it, and a viewer that needs a network to render a local diff is not a local viewer.
 *
 * Everything on it comes from `/api/state`, pushed over `/events` and re-fetched by polling when
 * that stream drops. The client renders and does nothing else — there is no route here that writes,
 * so the worst a mistake in this file can do is show the reader something wrong.
 *
 * Every value from the snapshot is escaped on its way into the DOM. The snapshot carries a diff,
 * and a diff carries whatever somebody wrote in the branch, `</script>` included. The one thing that
 * adds markup after escaping is `highlight`, which is why it only ever wraps spans around text that
 * has already been through `esc()`.
 *
 * The three functions with real logic in them live in `./render` and are pasted in here as source.
 * That keeps them under test — a template string is not runnable by the suite — without a build
 * step, a bundle or a second copy that drifts from the first. They are assigned to a name declared
 * here rather than injected as declarations, so a bundler renaming them cannot break the call sites.
 */
import { esc, highlight, hunkRows } from "./render";

export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>empo web</title>
<style>
:root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --dim:#6a6a6a; --line:#dcdcdc;
  --add:#e6ffec; --del:#ffebe9; --mark:#b34700; --panel:#f7f7f7;
  --tok-k:#cf222e; --tok-s:#0a3069; --tok-n:#0550ae; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#161616; --fg:#e6e6e6; --dim:#8f8f8f; --line:#333; --add:#15311d; --del:#3a1a1a;
    --mark:#ffa657; --panel:#1e1e1e; --tok-k:#ff7b72; --tok-s:#a5d6ff; --tok-n:#79c0ff; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  display:flex; flex-direction:column; height:100vh; }
header { flex:none; padding:10px 14px; border-bottom:1px solid var(--line); display:flex; gap:14px; flex-wrap:wrap; align-items:baseline; }
header b { font-weight:600; }
.dim { color:var(--dim); }
/* The header wraps, so its height is not a number this stylesheet may know: the columns take what
   is left over instead of subtracting a guess and scrolling the whole page past the viewport. */
main { flex:1; min-height:0; display:flex; align-items:stretch; gap:0; }
#left { width:340px; flex:none; border-right:1px solid var(--line); overflow:auto; padding:10px; }
#right { flex:1; overflow:auto; padding:10px 14px; min-width:0; }
h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:14px 0 6px; font-weight:600; }
h2:first-child { margin-top:0; }
ul { list-style:none; margin:0; padding:0; }
li { padding:2px 0; }
.file, .review { display:flex; gap:6px; width:100%; text-align:left; background:none; border:0; color:inherit; font:inherit; cursor:pointer; padding:2px 4px; border-radius:3px; }
.file:hover, .review:hover { background:var(--panel); }
.file[aria-current="true"], .review[aria-current="true"] { background:var(--panel); outline:1px solid var(--line); }
.file .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plus { color:#1a7f37; } .minus { color:#c0392b; }
/* A glyph, not a colour: read and unread have to be told apart without seeing the difference. */
.mark { display:inline-block; width:1.1em; flex:none; color:var(--dim); }
.hunk { border:1px solid var(--line); border-radius:4px; margin:0 0 12px; overflow-x:auto; }
.hunk .head { background:var(--panel); color:var(--dim); padding:2px 8px; border-bottom:1px solid var(--line); }
.row { display:flex; white-space:pre; }
.row .ln { width:46px; flex:none; text-align:right; padding-right:10px; color:var(--dim); }
.row.add { background:var(--add); } .row.del { background:var(--del); }
.row.context { color:var(--dim); }
/* Tokens, wrapped around already-escaped text by highlight(). */
.row .k { color:var(--tok-k); } .row .s { color:var(--tok-s); } .row .n { color:var(--tok-n); }
.row .c { color:var(--dim); font-style:italic; }
.row.context .k, .row.context .s, .row.context .n, .row.context .c { color:inherit; }
.row.hit { box-shadow:inset 3px 0 0 var(--mark); }
.finding { border:1px solid var(--line); border-radius:4px; padding:8px 10px; margin:0 0 8px; }
/* A finding on the line it is about, inside the hunk, so the claim is read with the code under it
   rather than three scrolls below it. */
.comment { border-top:1px solid var(--line); border-bottom:1px solid var(--line); background:var(--panel); padding:6px 8px; }
.comment .finding { margin:0; background:var(--bg); }
.comment .finding + .finding { margin-top:6px; }
.flash { outline:2px solid var(--mark); }
button.finding { display:block; width:100%; text-align:left; font:inherit; color:inherit; background:none; cursor:pointer; }
button.finding:hover { background:var(--panel); }
.finding.dropped { opacity:.65; }
.finding .t { font-weight:600; }
.finding p { margin:4px 0 0; white-space:pre-wrap; }
.tag { font-size:11px; border:1px solid var(--line); border-radius:3px; padding:0 5px; color:var(--dim); }
/* A review reads like a file row, because it is the same gesture: pick the thing the right-hand
   side is about. The whole block is hidden when only one review is live, which is the common case
   and the column it always had. */
.review .who { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.activity li { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.empty { color:var(--dim); }
</style>
</head>
<body>
<header>
  <b>empo web</b>
  <span id="phase" class="tag">idle</span>
  <span id="where" class="dim"></span>
  <span id="note" class="dim"></span>
  <span id="link" class="dim" style="margin-left:auto"></span>
</header>
<main>
  <div id="left">
    <h2 id="reviewsHead" hidden>Reviews</h2>
    <ul id="reviews" hidden></ul>
    <h2>Changed files</h2>
    <ul id="files"><li class="empty">nothing yet</li></ul>
    <h2>Read outside the diff</h2>
    <ul id="outside"><li class="empty">nothing yet</li></ul>
    <h2>Activity</h2>
    <ul id="activity" class="activity"><li class="empty">nothing yet</li></ul>
  </div>
  <div id="right">
    <h2 id="diffTitle">Diff</h2>
    <div id="diff"><p class="empty">No file selected.</p></div>
    <h2>Findings</h2>
    <div id="findings"><p class="empty">None yet.</p></div>
  </div>
</main>
<script>
const el = (id) => document.getElementById(id);

const esc = ${esc};
const hunkRows = ${hunkRows};
const highlight = ${highlight};

let snapshot = null;
let selected = null;
// Which review this window follows. It lives in the URL, so a reader running three reviews can keep
// three tabs open and each one comes back to the same review after a reload.
let session = new URLSearchParams(location.search).get("session") || "";
const query = () => (session === "" ? "" : "?session=" + encodeURIComponent(session));

function render(next) {
  snapshot = next;
  const files = snapshot.files || [];
  // Keep the reader's choice across updates; a snapshot arrives every time anything changes, and a
  // selection that reset four times a second would be no selection at all.
  if (selected === null || !files.some((f) => f.path === selected)) {
    selected = files.length > 0 ? files[0].path : null;
  }

  el("phase").textContent = snapshot.phase;
  const s = snapshot.session;
  el("where").textContent = s
    ? s.base + " -> " + (s.sourceBranch || (s.sha ? s.sha.slice(0, 8) : "working tree"))
      + (snapshot.round !== null ? "  round " + snapshot.round : "")
    : "no review running";
  el("note").textContent = snapshot.note || "";
  renderSessions();

  el("files").innerHTML = files.length === 0
    ? '<li class="empty">nothing yet</li>'
    : files.map(fileRow).join("");
  for (const button of document.querySelectorAll("#files .file")) {
    button.onclick = () => { selected = button.dataset.path; render(snapshot); };
  }

  el("outside").innerHTML = (snapshot.readOutsideDiff || []).length === 0
    ? '<li class="empty">nothing yet</li>'
    : snapshot.readOutsideDiff.map((p) => "<li>" + esc(p) + "</li>").join("");

  const activity = (snapshot.activity || []).slice(-40).reverse();
  el("activity").innerHTML = activity.length === 0
    ? '<li class="empty">nothing yet</li>'
    : activity.map((a) => '<li><span class="dim">' + esc(a.tool) + "</span> " + esc(a.path) + "</li>").join("");

  renderDiff(files);
  renderFindings();
}

// The server decides which review an unknown or empty key resolves to, so the row that matches
// snapshot.selected is the current one — never the one this page asked for.
function renderSessions() {
  const sessions = snapshot.sessions || [];
  // One review is the ordinary case and needs no list: the header already says which review this
  // is, and a list of one is a control that can only reselect what is already selected.
  const many = sessions.length > 1;
  el("reviewsHead").hidden = !many;
  el("reviews").hidden = !many;
  el("reviews").innerHTML = !many ? "" : sessions.map(reviewRow).join("");
  for (const button of document.querySelectorAll("#reviews .review")) {
    button.onclick = () => {
      session = button.dataset.key;
      // Replace, not push: the back button should leave the viewer, not walk back through which
      // review was looked at when.
      history.replaceState(null, "", location.pathname + query());
      // The next review has its own files and its own hunks, so neither the selected file nor the
      // drawn diff carries over.
      selected = null;
      drawn = null;
      reconnect();
    };
  }
}

function reviewRow(one) {
  // A saved round says which round it was and when; a live one has neither and says its phase,
  // which is the only thing about it that is still moving.
  const what = one.round === null
    ? esc(one.phase)
    : "round " + Number(one.round) + (one.at ? "  " + esc(one.at.slice(0, 10)) : "");
  return '<li><button class="review" data-key="' + esc(one.key) + '" aria-current="'
    + (one.key === snapshot.selected) + '">'
    + '<span class="who" title="' + esc(one.branch) + '">' + esc(one.id) + "  "
    + '<span class="dim">' + esc(one.branch) + "</span></span>"
    + '<span class="tag">' + what + "</span></button></li>";
}

function fileRow(file) {
  // What was read, not what was not: before a review opens its first file every changed file is
  // unread, and a mark on all of them marks nothing.
  const mark = file.read
    ? '<span class="mark" title="opened during this review">\u2713</span>'
    : '<span class="mark" title="not opened yet"> </span>';
  const findings = file.findingCount > 0
    ? '<span class="tag">' + Number(file.findingCount) + "</span>"
    : "";
  return '<li><button class="file" data-path="' + esc(file.path) + '" aria-current="'
    + (file.path === selected) + '">'
    + '<span class="name" title="' + esc(file.path) + '">' + mark + esc(file.path) + "</span>"
    + '<span class="plus">+' + Number(file.addedCount) + "</span>"
    + '<span class="minus">-' + Number(file.removedCount) + "</span>"
    + findings + "</button></li>";
}

// The diff is the one panel a reader is actually reading, and during the reading phase a snapshot
// arrives on every tool call the reviewer makes. Rewriting its innerHTML on each one would drop the
// text selection and clamp the scroll several times a minute, so it is rebuilt only when what it
// shows has changed: the file, its hunks, or the findings marked on its lines.
let drawn = null;

function renderDiff(files) {
  const file = files.find((f) => f.path === selected) || null;
  el("diffTitle").textContent = file ? file.path + "  (" + file.status + ")" : "Diff";
  const changed = file === null ? null : (snapshot.hunks || {})[file.path] || null;
  // Findings sit on lines in the new file, which is where the added lines are numbered.
  const mine = (snapshot.findings || []).filter((f) => file !== null && f.file === file.path);

  // The whole finding and not only its line: the comment drawn into the hunk carries the claim, the
  // suggestion and the verdict, so a gate that only changed "suspected" to "dropped" has to redraw.
  const key = JSON.stringify([selected, changed, mine, snapshot.session === null]);
  if (key === drawn) return;
  drawn = key;

  if (file === null) {
    el("diff").innerHTML = '<p class="empty">'
      + (snapshot.session === null ? "No review is running." : "No file selected.") + "</p>";
    return;
  }
  if (changed === null || changed.isBinary || changed.hunks.length === 0) {
    el("diff").innerHTML = '<p class="empty">'
      + (changed && changed.isBinary ? "Binary file." : "No hunks in the diff.") + "</p>";
    return;
  }
  const byLine = new Map();
  for (const f of mine) byLine.set(f.line, (byLine.get(f.line) || []).concat([f]));
  el("diff").innerHTML = changed.hunks.map((hunk) => hunkBlock(hunk, byLine, file.path)).join("");
}

function hunkBlock(hunk, byLine, path) {
  const head = "@@ -" + hunk.oldStart + "," + hunk.oldLines
    + " +" + hunk.newStart + "," + hunk.newLines + " @@";
  const rows = hunkRows(hunk).map((r) => row(r, byLine, path) + comment(r, byLine));
  return '<div class="hunk"><div class="head">' + esc(head) + "</div>" + rows.join("") + "</div>";
}

// Everything said about this line, under it. Nothing at all on a line nobody wrote about, which is
// almost every line.
function comment(r, byLine) {
  const here = r.newLine === null ? null : byLine.get(r.newLine);
  if (!here) return "";
  return '<div class="comment">' + here.map((f) => findingBlock(f, false)).join("") + "</div>";
}

const SIGN = { add: "+", del: "-", context: " " };

// Escape first, colour second. highlight() puts spans into the string, so what it is handed has to
// be text already: the reverse order would escape the spans and leave the diff's own markup live.
function row(r, byLine, path) {
  const hit = r.newLine !== null && byLine.has(r.newLine);
  return '<div class="row ' + r.kind + (hit ? " hit" : "") + '">'
    + '<span class="ln">' + (r.oldLine === null ? "" : Number(r.oldLine)) + "</span>"
    + '<span class="ln">' + (r.newLine === null ? "" : Number(r.newLine)) + "</span>"
    + "<span>" + SIGN[r.kind] + highlight(esc(r.text), path) + "</span></div>";
}

function renderFindings() {
  const findings = snapshot.findings || [];
  if (findings.length === 0) {
    el("findings").innerHTML = '<p class="empty">None yet.</p>';
    return;
  }
  // Survivors first, then what the gate dropped: showing both is the whole point, and the terminal
  // only ever prints the first group.
  const order = (f) => (f.survived === true ? 0 : f.survived === null ? 1 : 2);
  el("findings").innerHTML = findings.slice()
    .sort((a, b) => order(a) - order(b))
    // A finding the diff already carries is listed as a line to click, not repeated in full: its
    // claim is up there against the code. One on a line no hunk covers has nowhere else to be read.
    .map((f) => findingBlock(f, anchored(f)))
    .join("");
  for (const button of document.querySelectorAll("#findings .finding[data-path]")) {
    button.onclick = () => {
      selected = button.dataset.path;
      render(snapshot);
      focusFinding(button.dataset.finding);
    };
  }
}

// Whether some hunk of the diff covers this finding's line, which is what decides if jumping to it
// has anywhere to land.
function anchored(f) {
  const changed = (snapshot.hunks || {})[f.file];
  if (!changed || changed.isBinary) return false;
  return (changed.hunks || []).some((h) => f.line >= h.newStart && f.line < h.newStart + h.newLines);
}

// The id is whatever the reviewer wrote, so it is compared as data and never built into a selector.
function focusFinding(id) {
  for (const node of document.querySelectorAll("#diff .finding")) {
    if (node.dataset.finding !== id) continue;
    node.scrollIntoView({ block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1200);
    return;
  }
}

function findingBlock(f, compact) {
  const state = f.survived === true ? "survived" : f.survived === false ? "dropped" : "";
  const label = f.survived === true ? "survived" : f.survived === false ? "dropped" : "suspected";
  // A button only where clicking it goes somewhere; the same markup as a div otherwise, so the
  // inline copy and an unanchored one read the same.
  const tag = compact ? "button" : "div";
  const jump = compact
    ? ' data-path="' + esc(f.file) + '"'
    : "";
  return "<" + tag + ' class="finding ' + state + '" data-finding="' + esc(f.id) + '"' + jump + ">"
    + '<span class="tag">' + esc(f.severity) + '</span> '
    + '<span class="tag">' + esc(f.kind) + '</span> '
    + '<span class="tag">' + label + "</span> "
    + '<span class="t">' + esc(f.title) + "</span>"
    + '<p class="dim">' + esc(f.file) + ":" + Number(f.line) + "</p>"
    + (compact || !f.claim ? "" : "<p>" + esc(f.claim) + "</p>")
    + (compact || !f.suggestion ? "" : '<p class="dim">' + esc(f.suggestion) + "</p>")
    + "</" + tag + ">";
}

function status(text) { el("link").textContent = text; }

// SSE while it lasts, polling once it does not. The stream is the cheap path, but a viewer that
// goes blank because a laptop slept is worse than one that costs a request every two seconds.
let polling = null;
let failures = 0;
function poll() {
  if (polling !== null) return;
  status("polling");
  // A failed poll is silent otherwise, and a page that says "polling" over a server that died an
  // hour ago is telling the reader the review is quiet when it is actually gone.
  const tick = () => fetch("/api/state" + query())
    .then((r) => r.json())
    .then((state) => { failures = 0; status("polling"); render(state); })
    .catch(() => { failures += 1; if (failures > 1) status("offline"); });
  tick();
  polling = setInterval(tick, 2000);
}

let source = null;
// A reconnect is armed for five seconds after a stream drops. Switching review inside that window
// has to disarm it, or the pending timer opens a second stream over the one reconnect() just made:
// unreachable, never closed, and still calling render() from the review the reader left.
let retry = null;

// Switching review means a new stream: the server picks the session per connection, so the old one
// would keep pushing the review the reader just left.
function reconnect() {
  if (retry !== null) { clearTimeout(retry); retry = null; }
  if (source !== null) { source.close(); source = null; }
  connect();
}

function connect() {
  source = new EventSource("/events" + query());
  const mine = source;
  source.onopen = () => {
    if (polling !== null) { clearInterval(polling); polling = null; }
    failures = 0;
    status("live");
  };
  source.onmessage = (event) => {
    // One unparseable frame costs one frame. Throwing here would leave the page frozen on the last
    // good snapshot with the indicator still reading "live".
    try {
      render(JSON.parse(event.data));
    } catch {
      status("bad frame");
    }
  };
  // Guarded on mine: a stream the reader replaced by switching review still fires its error when
  // it closes, and an unguarded handler would reconnect it and start a second live stream.
  source.onerror = () => {
    mine.close();
    if (source !== mine) return;
    poll();
    retry = setTimeout(connect, 5000);
  };
}

connect();
</script>
</body>
</html>`;
}
