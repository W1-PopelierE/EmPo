<?php

namespace Acme\Models;

class Order
{
    public function totalInCents(): int
    {
        return $this->totalCents;
    }
}
