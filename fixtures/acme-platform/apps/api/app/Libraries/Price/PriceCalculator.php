<?php

namespace Acme\Libraries\Price;

use Acme\Models\Order;

class PriceCalculator
{
    private const TAX_RATE_BASIS_POINTS = 2100;

    public function total(Order $order): int
    {
        return $order->subtotal + $this->tax($order->subtotal);
    }

    private function tax(int $subtotal): int
    {
        return intdiv($subtotal * self::TAX_RATE_BASIS_POINTS, 10000);
    }
}
