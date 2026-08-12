<?php

namespace Acme\Mailables;

use Acme\Models\Order;
use Illuminate\Contracts\Queue\ShouldQueue;

class WelcomeMail implements ShouldQueue
{
    public function __construct(private Order $order)
    {
    }

    public function build(): void
    {
        $this->order->totalInCents();
    }
}
