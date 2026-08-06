import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
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

function transactionRule(extent: HazardExtent): HazardTransactionRule {
  const rule = block().transactions.find((candidate) => candidate.extent === extent);
  if (rule === undefined) throw new Error(`the php pack declares no "${extent}" transaction rule`);
  return rule;
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
    expect(transactionRule("balanced").open).toBe("{");
    expect(transactionRule("balanced").close).toBe("}");
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
    const rule = transactionRule("balanced");

    expect(matches(rule.pattern, "DB::transaction(function () use ($order) {")).toBe(true);
    expect(matches(rule.pattern, "DB::connection('ledger')->transaction(function () {")).toBe(true);
    expect(matches(rule.pattern, "$this->db->transaction(static function () {")).toBe(true);

    // A deliberate miss, pinned rather than left to be discovered. `DB::transaction($callback)` and
    // `DB::transaction(fn () => ...)` are both real, and neither has a `{` of its own for the
    // balanced extent to count, so matching them would run the extent to some later brace and
    // report every dispatch under it. Reporting nothing is the conservative half of that trade.
    expect(matches(rule.pattern, "DB::transaction($callback);")).toBe(false);
    expect(matches(rule.pattern, "DB::transaction(fn () => $order->place());")).toBe(false);
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
    const balanced = transactionRule("balanced").pattern;
    const span = transactionRule("span");

    expect(matches(balanced, corpus("app/Http/Controllers/CheckoutController.php"))).toBe(true);
    expect(jobsIn(corpus("app/Http/Controllers/CheckoutController.php"))).toEqual(["ChargeCard"]);
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
      "app/Libraries/Ledger/LedgerPoster.php",
      "app/Libraries/Ledger/LedgerCloser.php",
      "app/Libraries/Ledger/LedgerReverser.php",
    ];
    const declared = ["ChargeCard", "EmailReceipt", "PostLedgerEntry", "RebuildSearchIndex"];

    const found = new Set(files.flatMap((file) => jobsIn(corpus(file))));

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
    expect(matches(transactionRule("balanced").pattern, corpus(relPath))).toBe(false);
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
