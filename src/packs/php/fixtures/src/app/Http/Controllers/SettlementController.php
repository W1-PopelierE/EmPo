<?php

namespace Acme\Http\Controllers;

use Acme\Jobs\ChargeCard;
use Acme\Jobs\PostLedgerEntry;
use Acme\Jobs\RebuildSearchIndex;
use Acme\Models\Order;
use Illuminate\Database\Connection;
use Illuminate\Support\Facades\DB;

class SettlementController
{
    public function __construct(private Connection $db)
    {
    }

    // A hazard, and the arrow form of the one CheckoutController writes with a closure. An arrow
    // function's body is a single expression, so this transaction has no brace pair of its own:
    // its extent is the transaction call's own parentheses. The job is still queued the moment
    // this line runs, and a worker can pick it up before the transaction commits.
    public function settle(Order $order): void
    {
        DB::transaction(fn () => ChargeCard::dispatch($order));
    }

    // A hazard. The same form on a connection object instead of the facade, in the `static fn`
    // spelling, which is the arrow half of the `static function` closure the pack already reads.
    public function post(Order $order): void
    {
        $this->db->transaction(static fn () => PostLedgerEntry::dispatch($order));
    }

    // Not a hazard. The extent ends at the parenthesis matching the one the transaction call
    // opened, so the dispatch below is outside the transaction. An extent that failed to balance
    // would run to the end of the file and report this dispatch as a hazard it is not.
    public function reindex(Order $order): void
    {
        $this->db->transaction(static fn () => $order->totalInCents());

        dispatch(new RebuildSearchIndex());
    }
}
