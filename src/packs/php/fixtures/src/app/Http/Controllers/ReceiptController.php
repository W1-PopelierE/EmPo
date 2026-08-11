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

    // The facade spelling of the same render, and beside it the two spellings that must NOT be read
    // as one: `$mail->view(...)` is a method on somebody's object, and `TextView::make(...)` is a
    // class whose name merely ends in the facade's. A rule that took every `view(` or every
    // `View::make(` in the language would invent an edge out of either. Both refusals are a
    // lookbehind, and both lines are here to fail if one is ever dropped.
    public function preview(): mixed
    {
        $mail = new \Acme\Libraries\Price\PriceCalculator();
        $mail->view('orders.row');
        TextView::make('orders.row');

        return \View::make('layouts.app');
    }
}
