<?php

namespace Acme\Libraries\Ledger;

use Acme\Jobs\RebuildSearchIndex;
use Illuminate\Database\Connection;

class LedgerReverser
{
    public function __construct(private Connection $db)
    {
    }

    // Not a hazard, for the same reason as LedgerCloser: a rollback closes the transaction as
    // surely as a commit does. The connection object spells both without the DB facade.
    public function reverse(): void
    {
        $this->db->beginTransaction();
        $this->db->rollBack();

        dispatch(new RebuildSearchIndex());
    }
}
