<?php

namespace Acme\Tests\Feature;

use Acme\Http\Controllers\CheckoutController;

class CheckoutTest
{
    public function testConfirmIsAvailable(): void
    {
        $controller = new CheckoutController();

        // This is the fixture's deliberately BLIND flow: a test reaches the checkout code and
        // nothing here checks a value it produced. Asserting the type is the whole point, so keep
        // every assertion in this file on the far side of the php pack's assertionTerms, and do not
        // write one of those terms into this comment either. An earlier version asserted on
        // method_exists, which stopped being blind the day the pack learned that a boolean assertion
        // is a value assertion, and briefly took the whole blind-flow demonstration with it.
        $this->assertInstanceOf(CheckoutController::class, $controller);
    }
}
