<?php

namespace Acme\Libraries\Ledger;

use Acme\Jobs\PostLedgerEntry;
use Acme\Models\Order;
use Illuminate\Support\Facades\DB;

class LedgerPoster
{
    // A hazard. The transaction is opened by hand here rather than by a closure, and the dispatch
    // sits between the begin and the commit.
    public function post(Order $order): void
    {
        DB::beginTransaction();

        dispatch(new PostLedgerEntry($order));

        DB::commit();
    }
}
