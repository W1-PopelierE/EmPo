<?php

namespace Acme\Http\Controllers;

use Acme\Libraries\Price\PriceCalculator;
use Acme\Models\Order;

class OrderController
{
    public function store(PriceCalculator $prices): int
    {
        $order = new Order();
        $order->subtotal = 1000;

        return $prices->total($order);
    }

    public function show(int $order): Order
    {
        return new Order();
    }
}
