import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  compileHazards,
  type DispatchSite,
  findEnclosedDispatches,
} from "../../src/engine/hazards";
import { maskComments } from "../../src/engine/mask";
import { fixturesDir, loadPack } from "../../src/engine/pack-loader";
import { normalizeFqcn } from "../../src/engine/resolver";
import { packSchema } from "../../src/schema/pack.schema";
import type { HazardExtent, HazardTransactionRule } from "../../src/schema/types";

/**
 * The php pack's transaction-hazard markers, read off the pack the real loader returns.
 *
 * Every case below goes through `loadPack`, never through a hand-built object, because the failure
 * this file exists to catch is the one a hand-built object cannot see: zod strips a key the schema
 * does not declare, so a `hazards` block sitting in pack.json reaches the engine as undefined and
 * `empo query --hazards` answers "nobody looked" about a pack that looks like it does. That has
 * already happened here once, to `multilineQuotes`, and its unit tests stayed green throughout.
 *
 * The other half is the markers themselves. A wrong identifier reports nothing or reports fiction,
 * and neither announces itself, so each Laravel spelling the pack claims to know is matched here
 * against the pattern the pack really declares rather than against one retyped into the test.
 */

const loaded = loadPack("php");

function block(): NonNullable<typeof loaded.hazards> {
  if (loaded.hazards === undefined) {
    throw new Error('loadPack("php") returned no hazards block');
  }
  return loaded.hazards;
}

/**
 * One transaction rule, named by its extent and, where the pack declares more than one of an
 * extent, by the delimiter it counts. The pack has two `balanced` rules — the closure form counts
 * braces, the arrow form counts the transaction call's own parentheses — and asking for "balanced"
 * alone would silently hand back whichever is written first in pack.json.
 */
function transactionRule(extent: HazardExtent, open?: string): HazardTransactionRule {
  const rule = block().transactions.find(
    (candidate) => candidate.extent === extent && (open === undefined || candidate.open === open),
  );
  if (rule === undefined) throw new Error(`the php pack declares no "${extent}" transaction rule`);
  return rule;
}

/** Every dispatch the real php pack finds enclosed in the source below, comment-masked first. */
function sitesIn(...lines: string[]): DispatchSite[] {
  const compiled = compileHazards(loaded);
  if (compiled === null) throw new Error('loadPack("php") returned no hazards block');
  return findEnclosedDispatches(compiled, maskComments(lines.join("\n"), loaded.comments));
}

function matches(pattern: string | undefined, text: string): boolean {
  if (pattern === undefined) throw new Error("the rule declares no such pattern");
  return new RegExp(pattern).test(text);
}

function anyMatches(patterns: string[], text: string): boolean {
  return patterns.some((pattern) => new RegExp(pattern).test(text));
}

/** Every job name every dispatch rule reads out of one piece of source, in rule order. */
function jobsIn(text: string): string[] {
  return block().dispatches.flatMap((rule) =>
    [...text.matchAll(new RegExp(rule.pattern, "g"))].map((match) => match[rule.job] ?? ""),
  );
}

/** A corpus file as the engine sees it: comments blanked with this pack's own syntax first. */
function corpus(relPath: string): string {
  const raw = readFileSync(join(fixturesDir("php"), "src", relPath), "utf8");
  return maskComments(raw, loaded.comments);
}

describe("php pack hazards", () => {
  test("survives the real loader instead of being stripped at parse", () => {
    expect(loaded.hazards).toBeDefined();
    expect(block().dispatches.length).toBeGreaterThan(0);
    expect(block().deferAtSite.length).toBeGreaterThan(0);
    expect(block().deferAtDeclaration.length).toBeGreaterThan(0);
  });

  test("keeps each extent's companion field, which is what makes the extent computable", () => {
    // `balanced` without its delimiter pair counts nothing and `span` without an endPattern runs to
    // the end of the file. Both invent hazards rather than miss them, so both fields are asserted
    // off the loaded pack and not off pack.json.
    expect(transactionRule("balanced", "{").close).toBe("}");
    expect(transactionRule("balanced", "(").close).toBe(")");
    expect(transactionRule("span").endPattern).toBeDefined();
  });

  test("declares no marker anchored to a line, so no rule depends on a compile flag", () => {
    // A pattern written with ^ or $ means one thing compiled with `m` and another without it, and
    // the flags are the engine's to choose: engine/hazards.ts compiles these with "gm" today, and a
    // defer marker with "m" alone. A pack that needs no anchor cannot be broken by that choice
    // changing, and the failure it is insured against is silent: a rule that stopped matching
    // reports nothing, which reads exactly like a repository with no hazards in it.
    const every = [
      ...block().transactions.flatMap((rule) => [rule.pattern, rule.endPattern ?? ""]),
      ...block().dispatches.map((rule) => rule.pattern),
      ...block().deferAtSite,
      ...block().deferAtDeclaration,
    ];

    for (const pattern of every) {
      expect(pattern.includes("^"), `${pattern} anchors to a line start`).toBe(false);
      expect(pattern.replace(/\\\$/g, "").includes("$"), `${pattern} anchors to a line end`).toBe(
        false,
      );
    }
  });

  test("opens a transaction on both spellings Laravel offers for the closure form", () => {
    const rule = transactionRule("balanced", "{");

    expect(matches(rule.pattern, "DB::transaction(function () use ($order) {")).toBe(true);
    expect(matches(rule.pattern, "DB::connection('ledger')->transaction(function () {")).toBe(true);
    expect(matches(rule.pattern, "$this->db->transaction(static function () {")).toBe(true);

    // Neither of these has a `{` of its own for this rule's extent to count, so matching them here
    // would run the extent to some later brace and report every dispatch under it. The arrow form
    // is read by the rule below instead, which counts the parentheses it does have.
    // `DB::transaction($callback)` stays a deliberate miss: the callback's body is not at the site.
    expect(matches(rule.pattern, "DB::transaction($callback);")).toBe(false);
    expect(matches(rule.pattern, "DB::transaction(fn () => $order->place());")).toBe(false);
  });

  test("opens a transaction on the arrow form the closure rule cannot read", () => {
    const rule = transactionRule("balanced", "(");

    expect(matches(rule.pattern, "DB::transaction(fn () => ChargeCard::dispatch($order));")).toBe(
      true,
    );
    expect(
      matches(rule.pattern, "$connection->transaction(static fn () => $order->place());"),
    ).toBe(true);

    // The match is zero-width and ends just before the call's `(`, so the delimiter the extent
    // counts from is the transaction call's own parenthesis. A pattern that swallowed the `(`
    // would count from the arrow function's parameter list instead and close the extent there.
    expect("DB::transaction(fn () => $x);".search(new RegExp(rule.pattern))).toBe(0);
    expect(new RegExp(rule.pattern).exec("DB::transaction(fn () => $x);")?.[0]).toBe(
      "DB::transaction",
    );

    // The closure form is the other rule's, and exactly one rule may claim a site or the same
    // transaction is opened twice. `fn` has to be the callback, not the start of a longer word.
    expect(matches(rule.pattern, "DB::transaction(function () use ($order) {")).toBe(false);
    expect(matches(rule.pattern, "DB::transaction(fnMatcher());")).toBe(false);
    expect(matches(rule.pattern, "DB::transaction($callback);")).toBe(false);
  });

  test("opens a transaction on the DB facade only where DB is the whole identifier", () => {
    // `DB::` as a bare suffix would match inside any longer name, and a dispatch under someone
    // else's `AcmeDB::transaction` is a hazard the pack fabricated rather than one it found. Only
    // the unqualified facade and its root-qualified spelling are the facade; every rule that names
    // the facade carries the same boundary, so a lookalike opens no transaction at all.
    for (const rule of block().transactions) {
      const patterns = [rule.pattern, rule.endPattern ?? ""].filter((p) => p !== "");

      for (const pattern of patterns) {
        expect(matches(pattern, "AcmeDB::transaction(fn () => $x());")).toBe(false);
        expect(matches(pattern, "Acme\\DB::transaction(fn () => $x());")).toBe(false);
        expect(matches(pattern, "AcmeDB::beginTransaction();")).toBe(false);
        expect(matches(pattern, "Acme\\DB::commit();")).toBe(false);
      }
    }

    const arrow = transactionRule("balanced", "(");
    const closure = transactionRule("balanced", "{");

    expect(matches(arrow.pattern, "\\DB::transaction(fn () => $x());")).toBe(true);
    expect(matches(closure.pattern, "\\DB::transaction(function () {")).toBe(true);
    expect(matches(transactionRule("span").pattern, "\\DB::beginTransaction();")).toBe(true);
    expect(matches(transactionRule("span").endPattern ?? "", "\\DB::commit();")).toBe(true);
  });

  test("closes the arrow form's extent at the parenthesis the transaction call opened", () => {
    expect(sitesIn("<?php", "DB::transaction(fn () => ChargeCard::dispatch($order));")).toEqual([
      { job: "ChargeCard", line: 2, transactionLine: 2, deferredAtSite: false },
    ]);

    expect(
      sitesIn("<?php", "$this->db->transaction(static fn () => PostLedgerEntry::dispatch($o));"),
    ).toEqual([{ job: "PostLedgerEntry", line: 2, transactionLine: 2, deferredAtSite: false }]);

    // The dispatch below the call is outside the transaction, which is what the closing
    // parenthesis has to be found for: an extent that never balanced would run to the end of the
    // file and report it.
    expect(
      sitesIn(
        "<?php",
        "DB::transaction(fn () => $order->place());",
        "",
        "ChargeCard::dispatch($order);",
      ),
    ).toEqual([]);

    // Nested parentheses inside the arrow body are counted, so the extent still ends at the call's
    // own closer and not at the first `)` after it.
    expect(
      sitesIn(
        "<?php",
        "DB::transaction(fn () => ChargeCard::dispatch($order->fresh()));",
        "ChargeCard::dispatch($other);",
      ),
    ).toEqual([{ job: "ChargeCard", line: 2, transactionLine: 2, deferredAtSite: false }]);

    // The deferral is read on the arrow form exactly as on the closure one: it is the dispatch's
    // own statement that carries it, and the enclosure is unchanged.
    expect(
      sitesIn("<?php", "DB::transaction(fn () => ChargeCard::dispatch($order)->afterCommit());"),
    ).toEqual([{ job: "ChargeCard", line: 2, transactionLine: 2, deferredAtSite: true }]);
  });

  test("counts a parenthesis inside a string literal in the arrow body, a known blind spot", () => {
    // KNOWN LIMITATION, pinned rather than fixed. `balancedEnd` counts delimiters in the raw text
    // and engine/mask.ts deliberately never masks string contents (hazards.ts:14-26), so an
    // unbalanced parenthesis inside a string in the arrow body moves the extent's end. The arrow
    // rule reaches this in a way the closure rule mostly does not: an interpolated `"{$user->name}"`
    // stays brace-balanced, while a lone `(` in a string is unbalanced by nature.
    //
    // Not fixed here because masking string contents is an engine change, not something a pack-data
    // rule can express, and the engine masks comments only on purpose (the `string` edge family and
    // every route path live inside literals).

    // An unmatched `(` inflates the depth, so the extent swallows the statement below and invents a
    // hazard. The over-reporting direction, and the worse of the two.
    expect(
      sitesIn(
        "<?php",
        'DB::transaction(fn () => Log::info("charge (partial"));',
        "ChargeCard::dispatch($order);",
      ),
    ).toEqual([{ job: "ChargeCard", line: 3, transactionLine: 2, deferredAtSite: false }]);

    // An unmatched `)` closes the extent early and hides a real dispatch inside the transaction.
    // The under-reporting direction, which is the safe one.
    expect(
      sitesIn(
        "<?php",
        "DB::transaction(fn () => [Log::info('charge ) partial'), ChargeCard::dispatch($order)]);",
      ),
    ).toEqual([]);
  });

  test("opens and closes the manual span on the facade and on a connection object alike", () => {
    const rule = transactionRule("span");

    expect(matches(rule.pattern, "DB::beginTransaction();")).toBe(true);
    expect(matches(rule.pattern, "$this->db->beginTransaction();")).toBe(true);

    // Both spellings of the closer. Laravel's method is rollBack, and PHP method names are
    // case-insensitive, so DB::rollback() is the same call and is written in real code constantly.
    expect(matches(rule.endPattern, "DB::commit();")).toBe(true);
    expect(matches(rule.endPattern, "DB::rollBack();")).toBe(true);
    expect(matches(rule.endPattern, "DB::rollback();")).toBe(true);
    expect(matches(rule.endPattern, "$this->db->rollBack();")).toBe(true);

    // A commit is what closes it. Nothing that merely mentions the word does.
    expect(matches(rule.endPattern, "$this->commitMessage();")).toBe(false);
  });

  test("reads the job out of each dispatch spelling, and never the receiver", () => {
    expect(jobsIn("ChargeCard::dispatch($order);")).toEqual(["ChargeCard"]);
    expect(jobsIn("dispatch(new PostLedgerEntry($order));")).toEqual(["PostLedgerEntry"]);
    expect(jobsIn("$this->dispatch(new PostLedgerEntry($order));")).toEqual(["PostLedgerEntry"]);

    // The one that decides whether this pack reports a job or a facade. `Bus` matches the shape of
    // a job class exactly, so the static rule has to refuse it by name, and exactly one rule may
    // claim the line or the same dispatch is reported twice.
    expect(jobsIn("Bus::dispatch(new ChargeCard($order));")).toEqual(["ChargeCard"]);
  });

  test("reads the queue paths that never spell dispatch, which are the same hazard", () => {
    // A mailable handed to the queue, a job pushed through the Queue facade, a notification handed
    // to one notifiable and to a collection of them. None of these says `dispatch`, and each one
    // hands work to a queue that does not roll back with the transaction enclosing it.
    expect(jobsIn("Mail::to($user)->queue(new WelcomeMail($user));")).toEqual(["WelcomeMail"]);
    expect(jobsIn("Mail::to($u)->cc($x)->queue(new WelcomeMail($u));")).toEqual(["WelcomeMail"]);
    expect(jobsIn("Queue::push(new ChargeCard($order));")).toEqual(["ChargeCard"]);
    expect(jobsIn("$user->notify(new OrderShipped($order));")).toEqual(["OrderShipped"]);
    expect(jobsIn("Notification::send($users, new OrderShipped($order));")).toEqual([
      "OrderShipped",
    ]);

    // The delayed spellings, which are queued exactly as the immediate ones are: the delay is the
    // worker's, and the row the job wants still has to be committed before the worker wakes.
    expect(jobsIn("Mail::to($u)->later(now()->addHour(), new WelcomeMail($u));")).toEqual([
      "WelcomeMail",
    ]);
    expect(jobsIn("Queue::later(60, new ChargeCard($order));")).toEqual(["ChargeCard"]);

    // Through the facade's router, which is the same notify call one chain further along.
    expect(jobsIn('Notification::route("mail", $address)->notify(new OrderShipped);')).toEqual([
      "OrderShipped",
    ]);

    // Qualified exactly as the dispatch spellings capture it, so the same resolver reads it.
    expect(jobsIn("$user->notify(new \\Acme\\Notifications\\OrderShipped);")).toEqual([
      "\\Acme\\Notifications\\OrderShipped",
    ]);

    // The first argument written as an array puts a comma inside it. The rule wants a comma before
    // the `new` and takes the earliest one a `new` follows, so the notification is still named.
    expect(jobsIn("Notification::send([$a, $b], new OrderShipped);")).toEqual(["OrderShipped"]);

    // The queue-name spellings, where the job is one argument further along than the bare form.
    expect(jobsIn('Queue::pushOn("emails", new ChargeCard($o));')).toEqual(["ChargeCard"]);
    expect(jobsIn('Queue::laterOn("emails", 60, new ChargeCard($o));')).toEqual(["ChargeCard"]);
  });

  test("names the job and not the delay when later() is handed a constructed one", () => {
    // `later()` and `laterOn()` take the delay first, and Laravel accepts a DateTimeInterface or a
    // DateInterval there, so the first `new` inside the call is not always the job. The delayed
    // rules want a comma before the `new`; the immediate ones must not, because there the job is
    // the first argument. Naming the delay class would resolve a hazard to the wrong node, which
    // the pack ranks below naming nothing at all.
    expect(
      jobsIn("Mail::to($u)->later(new \\DateTimeImmutable('2026-01-01'), $mailable);"),
    ).toEqual([""]);
    expect(jobsIn("Queue::later(new DateTime('2026-01-01'), new ProcessPodcast($id));")).toEqual([
      "ProcessPodcast",
    ]);

    // The immediate spellings still read their first argument, which is where their job is.
    expect(jobsIn("Queue::push(new ChargeCard($order));")).toEqual(["ChargeCard"]);
    expect(jobsIn("Mail::to($user)->queue(new WelcomeMail($user));")).toEqual(["WelcomeMail"]);
  });

  test("refuses a namespace-qualified lookalike of the facades it is anchored to", () => {
    // `\b` treats the `\` in `Acme\Mail::` as a boundary, so a bare word anchor reads this
    // application's own Mail, Queue or Notification class as the Laravel facade and fabricates a
    // hazard. The anchor forbids a word character or a `\` before the name, which still admits the
    // global-namespace spelling every one of these facades is really written as.
    expect(jobsIn("Acme\\Mail::to($u)->queue(new WelcomeMail($u));")).toEqual([]);
    expect(jobsIn("Acme\\Queue::push(new ChargeCard($order));")).toEqual([]);
    expect(jobsIn("Acme\\Notification::send($users, new OrderShipped);")).toEqual([]);
    expect(jobsIn("Support\\Mail::to($u)->later(now(), new WelcomeMail($u));")).toEqual([]);

    // Rooted at the global namespace, which is the facade and not a lookalike.
    expect(jobsIn("\\Mail::to($u)->queue(new WelcomeMail($u));")).toEqual(["WelcomeMail"]);
    expect(jobsIn("\\Queue::push(new ChargeCard($order));")).toEqual(["ChargeCard"]);
  });

  test("reports the queue path unnamed rather than not at all when no class is written", () => {
    // The capture is optional on every rule whose receiver already proves the call is a queue
    // handoff, and engine/hazards.ts keeps a site whose group did not participate: the enclosure is
    // what makes it a hazard and naming the job is the resolver's problem. Dropping the site would
    // be the worse answer, because an absent row reads as a clean bill of health.
    expect(jobsIn("Mail::to($user)->queue($mailable);")).toEqual([""]);
    expect(jobsIn("Notification::send($users, $notification);")).toEqual([""]);

    // Unnamed and not misnamed, which is the whole reason the capture demands `new`. `static` is
    // not the notification, and a name that resolves to the wrong node is worse than no name:
    // engine/build.ts resolveJob binds a written name to a real node id.
    expect(jobsIn("Notification::send($users, static::build());")).toEqual([""]);
  });

  test("leaves the synchronous queue-path spellings alone, for the dispatchSync reason", () => {
    // notifyNow and sendNow deliver in-process, inside the transaction, exactly as dispatchNow runs
    // the job there. Same parenthesis defence: the method name has to end where the call opens.
    expect(jobsIn("$user->notifyNow(new OrderShipped($order));")).toEqual([]);
    expect(jobsIn("Notification::sendNow($users, new OrderShipped($order));")).toEqual([]);
  });

  test("refuses a queue() or notify() that is some other object's method", () => {
    // `dispatch(` was a Laravel token. `queue(` and `notify(` are ordinary PHP method names, so
    // these two rules cannot be spelled as bare method calls without reporting every spooler,
    // observer and toast written inside a transaction. The defence is the receiver on one side and
    // the `new` on the other: the queue rules are anchored to the Mail and Queue facades, and
    // ->notify() is read only when a notification is constructed in the call.
    expect(jobsIn('Cookie::queue(Cookie::make("name", "value"));')).toEqual([]);
    expect(jobsIn("$this->spool->queue(Priority::HIGH, $order->label());")).toEqual([]);
    expect(jobsIn("$printer->queue($document);")).toEqual([]);
    expect(jobsIn('Redis::connection()->queue("default");')).toEqual([]);
    expect(jobsIn("$observer->notify();")).toEqual([]);
    expect(jobsIn('$this->notify("success", "Saved");')).toEqual([]);
    expect(jobsIn("$observer->notify(Event::UPDATED, $payload);")).toEqual([]);
    expect(jobsIn("$user->notify(Notification::class);")).toEqual([]);

    // A known miss that the `new` buys, pinned so it stays a decision. A notification held in a
    // variable is a real hazard this pack does not see, and reading it would mean matching
    // `->notify(` on any receiver, which is what the rows above rule out.
    expect(jobsIn("$user->notify($notification);")).toEqual([]);
    expect(jobsIn("$user->notify(notification: new OrderShipped);")).toEqual([]);
  });

  test("reads a hand-rolled emitter's notify(new …) too, which is the accepted over-report", () => {
    // The one rule with no receiver to anchor to. `Mail::` and `Queue::` name a facade, and
    // `Notification::send` names one, but `->notify()` is how Laravel spells a notification on any
    // notifiable, so there is no receiver token to require. The `new` is the whole defence, and a
    // hand-rolled subject that constructs its event inline walks through it.
    //
    // Pinned rather than fixed, because the alternative costs more than it buys: narrowing to a
    // known notifiable would need the receiver's class, which no call-site rule has, and dropping
    // the rule loses `$user->notify(new OrderShipped)`, the commonest queue path in Laravel that
    // never says dispatch. The over-report is bounded — it needs an inline `new` inside a database
    // transaction — and .empo/conventions.md carries the judgement so a review does not relitigate.
    expect(jobsIn("$subject->notify(new PriceChanged($p));")).toEqual(["PriceChanged"]);
  });

  test("does not read the two queue paths that only the dispatched class can decide", () => {
    // Deliberately absent, and the reason is that neither call site says whether anything queues.
    // `Mail::to($u)->send($mailable)` queues only when that mailable implements ShouldQueue, and
    // `event(new X)` queues only when some listener of X does. Both facts live in another class,
    // and a rule that read the call site alone would report every synchronous send and every
    // synchronous event as this hazard. A fabricated finding is the one direction this tool may
    // not take (engine/hazards.ts), so the miss is taken instead.
    //
    // Deciding them is not impossible, only bigger than a call-site rule: engine/build.ts resolves
    // a dispatched name to a node before it reports, so a declaration-side marker could ask the
    // dispatched class whether it queues. That would change what every existing rule reports, so
    // it is its own change and not a line in this one.
    expect(jobsIn("Mail::to($user)->send(new WelcomeMail($user));")).toEqual([]);
    expect(jobsIn("event(new OrderPlaced($order));")).toEqual([]);
    expect(jobsIn("broadcast(new OrderPlaced($order));")).toEqual([]);
  });

  test("captures a qualified job as written, which is what resolves it without an index", () => {
    // `Hazard.job` is the job as written at the site, and engine/build.ts resolveJob takes a
    // qualified name as a node id outright and only falls back to the short-name index for a bare
    // one. Truncating a written namespace here would throw away the exact answer and buy the
    // ambiguity: two ChargeCard classes in two namespaces resolve to nothing through that index.
    expect(jobsIn("\\Acme\\Jobs\\ChargeCard::dispatch($order);")).toEqual([
      "Acme\\Jobs\\ChargeCard",
    ]);
    expect(jobsIn("Acme\\Jobs\\ChargeCard::dispatch($order);")).toEqual(["Acme\\Jobs\\ChargeCard"]);
    expect(jobsIn("dispatch(new \\Acme\\Jobs\\ChargeCard($order));")).toEqual([
      "\\Acme\\Jobs\\ChargeCard",
    ]);

    // The leading backslash is the resolver's to strip, and it strips it, so what the pack hands
    // over is a node id in the form this graph's ids are written.
    expect(normalizeFqcn("\\Acme\\Jobs\\ChargeCard")).toBe("Acme\\Jobs\\ChargeCard");
  });

  test("leaves the synchronous spellings alone, which is a correctness rule and not a gap", () => {
    // dispatchSync, dispatch_sync and dispatchNow run the job in-process, inside the transaction.
    // The rows the job reads do exist, and its own writes roll back with the transaction, so it is
    // a different failure shape entirely and reporting one of these as this hazard is fiction. The
    // whole defence is the parenthesis: every dispatch pattern here ends in `dispatch\(`, so the
    // method name has to end exactly where the call opens.
    expect(jobsIn("ChargeCard::dispatchSync($order);")).toEqual([]);
    expect(jobsIn("ChargeCard::dispatchNow($order);")).toEqual([]);
    expect(jobsIn("dispatch_sync(new ChargeCard($order));")).toEqual([]);
    expect(jobsIn("Bus::dispatchNow(new ChargeCard($order));")).toEqual([]);
    expect(jobsIn("Bus::dispatchSync(new ChargeCard($order));")).toEqual([]);
    expect(jobsIn("$queue->redispatch(new ChargeCard($order));")).toEqual([]);

    // Deliberately out of scope rather than fiction: this one runs after the response has been
    // sent, by which time the request's transaction has ended, so the queue cannot outrun it.
    expect(jobsIn("ChargeCard::dispatchAfterResponse($order);")).toEqual([]);

    // A known miss, pinned on purpose so the gap is a decision and not a surprise. dispatchIf and
    // dispatchUnless queue the job exactly as dispatch does, and reading them would mean matching
    // `::dispatch` without its parenthesis, which is the one thing keeping the rows above out.
    // Closing this needs its own alternation and its own rows, not a loosened anchor. If a later
    // change closes it, this row goes red and the report of what the pack covers is what to rewrite.
    expect(jobsIn("ChargeCard::dispatchIf($order->isPaid(), $order);")).toEqual([]);
    expect(jobsIn("ChargeCard::dispatchUnless($order->isFree(), $order);")).toEqual([]);
  });

  test("recognises the deferral chained at the dispatch site, wrapped or not", () => {
    const site = block().deferAtSite;

    expect(anyMatches(site, "ChargeCard::dispatch($order)->afterCommit();")).toBe(true);
    expect(anyMatches(site, "ChargeCard::dispatch($order)\n    ->afterCommit();")).toBe(true);

    // beforeCommit() is the real opposite of this call: it forces the dispatch to happen without
    // waiting, which is the hazard rather than the cure.
    expect(anyMatches(site, "ChargeCard::dispatch($order)->beforeCommit();")).toBe(false);
    expect(anyMatches(site, "ChargeCard::dispatch($order)->onQueue('billing');")).toBe(false);
  });

  test("recognises the deferral declared on the job class in the spelling Laravel reads", () => {
    const declaration = block().deferAtDeclaration;

    expect(anyMatches(declaration, "    public bool $afterCommit = true;")).toBe(true);
    expect(anyMatches(declaration, "    public $afterCommit = true;")).toBe(true);

    // The dispatcher reads this property off the job instance from outside the class, so a
    // non-public one does not defer anything. Matching it would report a hazard as handled.
    expect(anyMatches(declaration, "    protected bool $afterCommit = true;")).toBe(false);
    expect(anyMatches(declaration, "    private $afterCommit = true;")).toBe(false);
    expect(anyMatches(declaration, "    public bool $afterCommit = false;")).toBe(false);
  });

  test("finds every marker it claims in the fixture corpus, on the masked source", () => {
    const balanced = transactionRule("balanced", "{").pattern;
    const arrow = transactionRule("balanced", "(").pattern;
    const span = transactionRule("span");

    expect(matches(balanced, corpus("app/Http/Controllers/CheckoutController.php"))).toBe(true);
    expect(jobsIn(corpus("app/Http/Controllers/CheckoutController.php"))).toEqual(["ChargeCard"]);
    expect(matches(arrow, corpus("app/Http/Controllers/SettlementController.php"))).toBe(true);
    // The closure rule finds nothing there, which is what the arrow rule exists for.
    expect(matches(balanced, corpus("app/Http/Controllers/SettlementController.php"))).toBe(false);
    expect(
      anyMatches(block().deferAtSite, corpus("app/Http/Controllers/RefundController.php")),
    ).toBe(true);
    expect(anyMatches(block().deferAtDeclaration, corpus("app/Jobs/EmailReceipt.php"))).toBe(true);
    // The site that carries no deferral of its own: only the job class it names defers it.
    expect(
      anyMatches(block().deferAtSite, corpus("app/Http/Controllers/ReceiptController.php")),
    ).toBe(false);
    expect(matches(span.pattern, corpus("app/Libraries/Ledger/LedgerPoster.php"))).toBe(true);
    expect(matches(span.endPattern, corpus("app/Libraries/Ledger/LedgerPoster.php"))).toBe(true);
    expect(matches(span.pattern, corpus("app/Libraries/Ledger/LedgerReverser.php"))).toBe(true);
    expect(matches(span.endPattern, corpus("app/Libraries/Ledger/LedgerReverser.php"))).toBe(true);
  });

  test("dispatches the whole corpus at jobs the corpus really declares", () => {
    // A marker that captured one segment too many or too few still matches, and the difference only
    // shows as a hazard whose target never resolves. Every name read out of the corpus has to be a
    // job class the corpus also contains.
    const files = [
      "app/Http/Controllers/CheckoutController.php",
      "app/Http/Controllers/SubscriptionController.php",
      "app/Http/Controllers/RefundController.php",
      "app/Http/Controllers/ReceiptController.php",
      "app/Http/Controllers/CatalogController.php",
      "app/Http/Controllers/QueueHandoffController.php",
      "app/Http/Controllers/SpoolController.php",
      "app/Http/Controllers/SettlementController.php",
      "app/Libraries/Ledger/LedgerPoster.php",
      "app/Libraries/Ledger/LedgerCloser.php",
      "app/Libraries/Ledger/LedgerReverser.php",
    ];
    const declared = [
      "ChargeCard",
      "EmailReceipt",
      "PostLedgerEntry",
      "RebuildSearchIndex",
      "WelcomeMail",
      "OrderShipped",
    ];

    // The empty name is dropped rather than declared: SpoolController holds a `later()` with a
    // constructed delay on purpose, and the rule leaving that job unnamed is the point of the line.
    // A name that is not there cannot resolve to the wrong node, which is what this test guards.
    const found = new Set(
      files.flatMap((file) => jobsIn(corpus(file))).filter((job) => job !== ""),
    );

    expect(found.size).toBeGreaterThan(0);
    for (const job of found) {
      expect(declared, `${job} is dispatched by the corpus but declared nowhere in it`).toContain(
        job,
      );
    }
  });

  test("opens no transaction on a comment that spells one, because the mask runs first", () => {
    // CatalogController holds `DB::beginTransaction()` in a comment on purpose. A span with nothing
    // to close it runs to the end of the file, so reading this file unmasked reports the dispatch
    // under the comment as a hazard, with a citation pointing at a comment. That is the phantom
    // edge docs/04-language-packs.md argues about, on the hazard axis.
    const relPath = "app/Http/Controllers/CatalogController.php";
    const raw = readFileSync(join(fixturesDir("php"), "src", relPath), "utf8");

    expect(matches(transactionRule("span").pattern, raw)).toBe(true);
    expect(matches(transactionRule("span").pattern, corpus(relPath))).toBe(false);
    expect(matches(transactionRule("balanced", "{").pattern, corpus(relPath))).toBe(false);
    expect(matches(transactionRule("balanced", "(").pattern, corpus(relPath))).toBe(false);
    expect(jobsIn(corpus(relPath))).toEqual(["RebuildSearchIndex"]);
  });

  test("leaves hazards absent, not empty, for a pack that declares none", () => {
    // Absent is the claim "this language has no hazard worth looking for" and empty is the claim
    // "looked and found none". A default would collapse the two and `empo query --hazards` could no
    // longer print the difference.
    const result = packSchema.safeParse({
      name: "mini",
      version: "1.0.0",
      match: { extensions: [".php"] },
      node: { id: { strategy: "fqcn" }, kindRules: [{ kind: "class" }] },
    });

    expect(result.success).toBe(true);
    expect(result.data?.hazards).toBeUndefined();
  });
});
