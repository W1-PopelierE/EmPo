<?php

namespace Acme\Console;

class Kernel
{
    // The scheduler is an entrypoint. Nothing here names a class, so before the scheduled-command
    // join these three lines coupled the schedule to nothing and every command below read as a leaf.
    protected function schedule($schedule): void
    {
        $schedule->command('acme:reconcile')->dailyAt('03:20');
        $schedule->command('acme:sweep --force')->everyFiveMinutes();
    }
}
