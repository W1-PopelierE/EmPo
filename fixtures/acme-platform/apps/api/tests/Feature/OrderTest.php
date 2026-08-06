<?php

namespace Acme\Tests\Feature;

use Acme\Libraries\Price\PriceCalculator;
use Acme\Models\Order;

class OrderTest
{
    public function testTotalAddsTaxToTheSubtotal(): void
    {
        $order = new Order();
        $order->subtotal = 1000;

        $this->assertSame(1210, (new PriceCalculator())->total($order));
    }
}
