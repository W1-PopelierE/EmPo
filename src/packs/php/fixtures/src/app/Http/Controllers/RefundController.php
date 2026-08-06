<?php

namespace Acme\Http\Controllers;

use Acme\Jobs\ChargeCard;
use Acme\Models\Order;
use Illuminate\Support\Facades\DB;

class RefundController
{
    // Not a hazard. afterCommit() holds this one dispatch until the transaction commits.
    //
    // The chain is wrapped on purpose. The deferral is read from the dispatch's whole statement,
    // up to its terminator, and not from the dispatch's own line, so this is the spelling that
    // tells the two apart: a line-wise reading calls it undeferred and reports a hazard the code
    // has already handled.
    public function store(Order $order): void
    {
        DB::transaction(function () use ($order) {
            ChargeCard::dispatch($order)
                ->afterCommit();
        });
    }
}
