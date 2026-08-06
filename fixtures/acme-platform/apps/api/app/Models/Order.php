<?php

namespace Acme\Models;

class Order
{
    public int $subtotal = 0;

    public function isEmpty(): bool
    {
        return $this->subtotal === 0;
    }
}
