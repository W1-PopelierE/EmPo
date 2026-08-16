<?php

namespace Acme\Console\Commands;

use Acme\Jobs\ChargeCard;
use Acme\Models\Order;

class ReconcileCommand
{
    protected $signature = 'acme:reconcile';

    // One dispatch per row of a query this file does not bound. Not a hazard and not a finding:
    // the graph cannot know how many rows come back, which is exactly why the line is reported as
    // a fact to whoever is reading the diff that widened the query.
    public function handle(): void
    {
        foreach (Order::query()->get() as $order) {
            ChargeCard::dispatch($order);
        }
    }
}
