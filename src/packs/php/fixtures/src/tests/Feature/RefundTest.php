<?php

use Acme\Models\Order;

/**
 * A value-asserting test written the way a Pest suite writes one: no class, so the pack's
 * `fallback: "path"` names the node, and the assertion is an expectation chain rather than a
 * PHPUnit `assert*` call.
 */
it('refunds the whole order total in cents', function () {
    $order = new Order();

    expect($order->refundCents())->toBe(1250);
});
