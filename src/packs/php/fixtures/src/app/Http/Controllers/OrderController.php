<?php

namespace Acme\Http\Controllers;

use Acme\Libraries\Price\PriceCalculator;

class OrderController
{
    public const LISTENERS = [
        'order.saved' => 'Acme\Observers\OrderObserver',
    ];

    public function store(): int
    {
        $order = \Acme\Models\Order::create([]);

        return (new PriceCalculator())->totalFor($order);
    }
}
