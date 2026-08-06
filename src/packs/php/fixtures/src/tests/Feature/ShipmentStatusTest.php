<?php

namespace Acme\Tests\Feature;

/**
 * A test that only proves the route answered. Nothing here checks a value, so this file is the
 * control for `assertsValue`: docs/04 draws the line at "asserts a value" versus "only asserts HTTP
 * 200", and every assertion below is on the far side of it.
 */
class ShipmentStatusTest
{
    public function testIndexIsReachable(): void
    {
        $this->get('/api/v1/shipments')->assertStatus(200);
    }

    public function testMissingShipmentIsNotFound(): void
    {
        $this->get('/api/v1/shipments/999')->assertNotFound();
    }
}
