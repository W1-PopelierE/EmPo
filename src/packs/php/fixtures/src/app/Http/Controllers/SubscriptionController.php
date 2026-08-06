<?php

namespace Acme\Http\Controllers;

use Acme\Jobs\ChargeCard;
use Acme\Models\Order;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\DB;

class SubscriptionController
{
    // The same hazard as CheckoutController, written through the Bus facade instead. The job is
    // ChargeCard, not Bus.
    public function renew(Order $order): void
    {
        DB::transaction(function () use ($order) {
            Bus::dispatch(new ChargeCard($order));
        });
    }
}
