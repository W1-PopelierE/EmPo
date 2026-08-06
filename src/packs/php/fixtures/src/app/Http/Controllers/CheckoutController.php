<?php

namespace Acme\Http\Controllers;

use Acme\Jobs\ChargeCard;
use Acme\Models\Order;
use Illuminate\Support\Facades\DB;

class CheckoutController
{
    // A hazard. The job is queued the moment this line runs, so a worker can pick it up before
    // the closure returns and the transaction commits, and then the order row is not there yet.
    public function store(Order $order): void
    {
        DB::transaction(function () use ($order) {
            $order->totalInCents();

            ChargeCard::dispatch($order);
        });
    }
}
