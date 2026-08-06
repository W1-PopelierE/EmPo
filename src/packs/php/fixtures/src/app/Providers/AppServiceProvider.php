<?php

namespace Acme\Providers;

use Acme\Models\Order;
use Acme\Observers\OrderObserver;

class AppServiceProvider
{
    public function boot(): void
    {
        Order::observe(OrderObserver::class);
    }
}
