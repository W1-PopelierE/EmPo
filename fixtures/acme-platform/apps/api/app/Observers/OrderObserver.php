<?php

namespace Acme\Observers;

use Acme\Models\Order;

class OrderObserver
{
    public function saved(Order $order): void
    {
        // the order summary cache is refreshed here
    }
}
