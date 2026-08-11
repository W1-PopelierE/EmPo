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

    // The edge this corpus had no way to write before the `view` strategy landed: a controller
    // naming the template it renders. Every template edge here used to run out of a blade file, so
    // a change to this class never reported the page it draws, which is the direction a reviewer
    // asks about.
    public function show(int $id): mixed
    {
        return view('orders.show', ['order' => $id]);
    }
}
