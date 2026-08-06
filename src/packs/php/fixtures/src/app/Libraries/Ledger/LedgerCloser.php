<?php

namespace Acme\Libraries\Ledger;

use Acme\Jobs\RebuildSearchIndex;
use Acme\Models\Order;
use Illuminate\Support\Facades\DB;

class LedgerCloser
{
    // Not a hazard. The commit has already closed the transaction, so the dispatch below it is
    // outside, and the span has to end where the commit is rather than at the end of the file.
    public function close(Order $order): void
    {
        DB::beginTransaction();
        $order->totalInCents();
        DB::commit();

        dispatch(new RebuildSearchIndex());
    }
}
