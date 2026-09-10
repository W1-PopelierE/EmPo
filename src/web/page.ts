/**
 * The page, as one string. No build step, no bundle, no CDN: the binary is offline by the time a
 * reader runs it, and a viewer that needs a network to render a local diff is not a local viewer.
 *
 * Everything on it comes from `/api/state`, pushed over `/events` and re-fetched by polling when
 * that stream drops. The client renders and does nothing else — there is no route here that writes,
 * so the worst a mistake in this file can do is show the reader something wrong.
 *
 * Every value from the snapshot is escaped on its way into the DOM. The snapshot carries a diff,
 * and a diff carries whatever somebody wrote in the branch, `</script>` included.
 */
export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>empo web</title>
<style>
:root { color-scheme: light dark; --bg:#fff; --fg:#1a1a1a; --dim:#6a6a6a; --line:#dcdcdc;
  --add:#e6ffec; --del:#ffebe9; --mark:#b34700; --panel:#f7f7f7; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#161616; --fg:#e6e6e6; --dim:#8f8f8f; --line:#333; --add:#15311d; --del:#3a1a1a;
    --mark:#ffa657; --panel:#1e1e1e; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
header { padding:10px 14px; border-bottom:1px solid var(--line); display:flex; gap:14px; flex-wrap:wrap; align-items:baseline; }
header b { font-weight:600; }
.dim { color:var(--dim); }
main { display:flex; align-items:flex-start; gap:0; }
#left { width:340px; flex:none; border-right:1px solid var(--line); height:calc(100vh - 44px); overflow:auto; padding:10px; }
#right { flex:1; height:calc(100vh - 44px); overflow:auto; padding:10px 14px; min-width:0; }
h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:14px 0 6px; font-weight:600; }
h2:first-child { margin-top:0; }
ul { list-style:none; margin:0; padding:0; }
li { padding:2px 0; }
.file { display:flex; gap:6px; width:100%; text-align:left; background:none; border:0; color:inherit; font:inherit; cursor:pointer; padding:2px 4px; border-radius:3px; }
.file:hover { background:var(--panel); }
.file[aria-current="true"] { background:var(--panel); outline:1px solid var(--line); }
.file .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plus { color:#1a7f37; } .minus { color:#c0392b; }
.unread { color:var(--mark); }
.hunk { border:1px solid var(--line); border-radius:4px; margin:0 0 12px; overflow-x:auto; }
.hunk .head { background:var(--panel); color:var(--dim); padding:2px 8px; border-bottom:1px solid var(--line); }
.row { display:flex; white-space:pre; }
.row .n { width:60px; flex:none; text-align:right; padding-right:10px; color:var(--dim); }
.row.add { background:var(--add); } .row.del { background:var(--del); }
.row.hit { box-shadow:inset 3px 0 0 var(--mark); }
.finding { border:1px solid var(--line); border-left:3px solid var(--dim); border-radius:4px; padding:8px 10px; margin:0 0 8px; }
.finding.survived { border-left-color:#1a7f37; }
.finding.dropped { border-left-color:var(--dim); opacity:.65; }
.finding .t { font-weight:600; }
.finding p { margin:4px 0 0; white-space:pre-wrap; }
.tag { font-size:11px; border:1px solid var(--line); border-radius:3px; padding:0 5px; color:var(--dim); }
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
const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const el = (id) => document.getElementById(id);

let snapshot = null;
let selected = null;

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

function fileRow(file) {
  const mark = file.read ? "" : '<span class="unread" title="never opened">*</span>';
  const findings = file.findingCount > 0 ? '<span class="tag">' + file.findingCount + "</span>" : "";
  return '<li><button class="file" data-path="' + esc(file.path) + '" aria-current="'
    + (file.path === selected) + '">'
    + '<span class="name" title="' + esc(file.path) + '">' + mark + esc(file.path) + "</span>"
    + '<span class="plus">+' + Number(file.addedCount) + "</span>"
    + '<span class="minus">-' + Number(file.removedCount) + "</span>"
    + findings + "</button></li>";
}

function renderDiff(files) {
  const file = files.find((f) => f.path === selected) || null;
  el("diffTitle").textContent = file ? file.path + "  (" + file.status + ")" : "Diff";
  if (file === null) {
    el("diff").innerHTML = '<p class="empty">'
      + (snapshot.session === null ? "No review is running." : "No file selected.") + "</p>";
    return;
  }
  const changed = (snapshot.hunks || {})[file.path] || null;
  if (changed === null || changed.isBinary || changed.hunks.length === 0) {
    el("diff").innerHTML = '<p class="empty">'
      + (changed && changed.isBinary ? "Binary file." : "No hunks in the diff.") + "</p>";
    return;
  }
  // Findings sit on lines in the new file, which is where the added lines are numbered.
  const marks = new Set(
    (snapshot.findings || []).filter((f) => f.file === file.path).map((f) => f.line),
  );
  el("diff").innerHTML = changed.hunks.map((hunk) => hunkBlock(hunk, marks)).join("");
}

function hunkBlock(hunk, marks) {
  const head = "@@ -" + hunk.oldStart + "," + hunk.oldLines
    + " +" + hunk.newStart + "," + hunk.newLines + " @@";
  const rows = hunk.removed.map((line) => row("del", line, false))
    .concat(hunk.added.map((line) => row("add", line, marks.has(line.line))));
  return '<div class="hunk"><div class="head">' + esc(head) + "</div>" + rows.join("") + "</div>";
}

function row(kind, line, hit) {
  return '<div class="row ' + kind + (hit ? " hit" : "") + '">'
    + '<span class="n">' + Number(line.line) + "</span>"
    + "<span>" + (kind === "add" ? "+" : "-") + esc(line.text) + "</span></div>";
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
    .map(findingBlock).join("");
}

function findingBlock(f) {
  const state = f.survived === true ? "survived" : f.survived === false ? "dropped" : "";
  const label = f.survived === true ? "survived" : f.survived === false ? "dropped" : "suspected";
  return '<div class="finding ' + state + '">'
    + '<span class="tag">' + esc(f.severity) + '</span> '
    + '<span class="tag">' + esc(f.kind) + '</span> '
    + '<span class="tag">' + label + "</span> "
    + '<span class="t">' + esc(f.title) + "</span>"
    + '<p class="dim">' + esc(f.file) + ":" + Number(f.line) + "</p>"
    + (f.claim ? "<p>" + esc(f.claim) + "</p>" : "")
    + (f.dropped ? '<p class="dim">dropped: ' + esc(f.dropped) + "</p>" : "")
    + (f.suggestion ? '<p class="dim">' + esc(f.suggestion) + "</p>" : "")
    + "</div>";
}

function status(text) { el("link").textContent = text; }

// SSE while it lasts, polling once it does not. The stream is the cheap path, but a viewer that
// goes blank because a laptop slept is worse than one that costs a request every two seconds.
let polling = null;
function poll() {
  if (polling !== null) return;
  status("polling");
  const tick = () => fetch("/api/state").then((r) => r.json()).then(render).catch(() => {});
  tick();
  polling = setInterval(tick, 2000);
}

function connect() {
  const source = new EventSource("/events");
  source.onopen = () => {
    if (polling !== null) { clearInterval(polling); polling = null; }
    status("live");
  };
  source.onmessage = (event) => render(JSON.parse(event.data));
  source.onerror = () => { source.close(); poll(); setTimeout(connect, 5000); };
}

connect();
</script>
</body>
</html>`;
}
