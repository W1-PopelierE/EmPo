<?php

namespace Acme\Jobs;

use Illuminate\Contracts\Queue\ShouldQueue;

class RebuildSearchIndex implements ShouldQueue
{
    public function handle(): void
    {
    }
}
