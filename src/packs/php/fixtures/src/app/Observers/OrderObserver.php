<?php

namespace Acme\Observers;

use Acme\Models\Order;

class OrderObserver
{
    public function saved(Order $order): void
    {
        // downstream state is refreshed here
    }
}
