<?php

namespace Acme\Tests\Feature;

use Acme\Libraries\Price\PriceCalculator;
use Acme\Models\Order;

class OrderTest
{
    public function testTotalIsCalculatedInCents(): void
    {
        $order = new Order();

        $this->assertEquals(1250, (new PriceCalculator())->totalFor($order));
    }

    public function testStoreCreatesAnOrder(): void
    {
        $this->post('/api/v1/orders', [])->assertStatus(201);
    }
}
