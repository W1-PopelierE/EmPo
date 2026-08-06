<?php

namespace Acme\Tests\Feature;

/**
 * The control for `assertionExcludes`. Every assertion below is `assertTrue(`, which the pack does
 * carry as a term, wrapped around a liveness predicate, which is the one thing a substring term
 * cannot judge for itself: `assertTrue($order->isPaid())` checks a value and
 * `assertTrue(method_exists(...))` checks that code exists at all, and the two differ only in the
 * argument.
 *
 * If this file ever scores `assertsValue: true`, the exclusion list stopped being read. Both of the
 * spellings below are also run through the real matcher in test/packs/php.test.ts, so a flip is red
 * there too. What this file adds is the whole pipeline: a real file, scanned from disk and extracted
 * the way an index runs, rather than a string handed to the matcher. That distinction is a scar and
 * not a preference, because `multilineQuotes` was once declared in a pack.json and in the Pack type
 * but not in pack.schema.ts, so zod stripped it at load and the code reading it did nothing, while
 * its unit tests passed because they built the object by hand.
 *
 * The one place a flip would be silent is this corpus itself: expected.json is rewritten wholesale
 * by `empo pack test php --update`, with no comparison against what it held before, so a snapshot
 * agrees with whatever the code just did and deleting this file would cost one regeneration. It is
 * therefore named in test/packs/php.test.ts alongside its three siblings, which is what makes its
 * verdict, and its existence, load-bearing outside the regenerable snapshot.
 */
class LivenessTest
{
    public function testTheSuiteIsWired(): void
    {
        $this->assertTrue(method_exists($this, 'testTheSuiteIsWired'));
        $this->assertTrue(class_exists(LivenessTest::class));
    }
}
