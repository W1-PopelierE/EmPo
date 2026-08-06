<?php

namespace Acme\Jobs;

use Acme\Models\Order;
use Illuminate\Contracts\Queue\ShouldQueue;

class EmailReceipt implements ShouldQueue
{
    // Laravel holds every dispatch of this job until the enclosing transaction commits, so
    // dispatching it from inside one is not a hazard no matter where the dispatch is written.
    public bool $afterCommit = true;

    public function __construct(private Order $order)
    {
    }

    public function handle(): void
    {
        $this->order->totalInCents();
    }
}
