<?php

namespace Acme\Notifications;

use Acme\Models\Order;
use Illuminate\Contracts\Queue\ShouldQueue;

class OrderShipped implements ShouldQueue
{
    public function __construct(private Order $order)
    {
    }

    public function toMail(): void
    {
        $this->order->totalInCents();
    }
}
