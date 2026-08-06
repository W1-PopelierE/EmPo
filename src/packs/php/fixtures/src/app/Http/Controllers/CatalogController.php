<?php

namespace Acme\Http\Controllers;

use Acme\Jobs\RebuildSearchIndex;

class CatalogController
{
    // Not a hazard. No transaction is open, so there is nothing for the queue to outrun.
    //
    // The line below is a comment on purpose. It spells DB::beginTransaction() exactly, and a
    // transaction opened by a span rule runs to the end of the file when nothing closes it, so a
    // hazard scan that reads this file before the comments are blanked reports the dispatch under
    // it. That is the phantom-edge failure docs/04-language-packs.md describes, on a second axis.
    public function refresh(): void
    {
        dispatch(new RebuildSearchIndex());
    }
}
