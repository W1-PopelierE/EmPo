<?php

namespace Acme\Http\Controllers;

use Acme\Jobs\EmailReceipt;
use Acme\Models\Order;
use Illuminate\Support\Facades\DB;

class ReceiptController
{
    // Not a hazard, and nothing at this site says so: EmailReceipt declares $afterCommit on the
    // job class, so every dispatch of it waits for the commit.
    public function store(Order $order): void
    {
        DB::transaction(function () use ($order) {
            EmailReceipt::dispatch($order);
        });
    }
}
