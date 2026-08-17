<?php

namespace Acme\Console\Commands;

class SweepCommand
{
    // Arguments and options after the command name, which the scheduler entry also writes. Both
    // sides key on the leading token or the two halves never meet.
    protected $signature = 'acme:sweep {--force} {club?}';

    public function handle(): void
    {
    }
}
