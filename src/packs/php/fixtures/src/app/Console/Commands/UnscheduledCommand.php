<?php

namespace Acme\Console\Commands;

class UnscheduledCommand
{
    // Declared and never scheduled. It produces a symbol nobody consumes, which is no edge and no
    // warning: absent is not empty, and a command run by hand is not a defect.
    protected $signature = 'acme:backfill';

    public function handle(): void
    {
    }
}
