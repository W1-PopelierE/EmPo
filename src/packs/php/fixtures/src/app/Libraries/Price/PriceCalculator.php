<?php

namespace Acme\Libraries\Price;

use Acme\Models\Order;

class PriceCalculator
{
    public function totalFor(Order $order): int
    {
        return $order->totalInCents();
    }
}
