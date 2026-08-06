<?php

namespace Acme\Jobs;

use Acme\Models\Order;
use Illuminate\Contracts\Queue\ShouldQueue;

class PostLedgerEntry implements ShouldQueue
{
    public function __construct(private Order $order)
    {
    }

    public function handle(): void
    {
        $this->order->totalInCents();
    }
}
