<?php

namespace Acme\Http\Controllers;

use Acme\Models\Order;

/*
 * The old flow called \Acme\Libraries\Price\PriceCalculator::legacyTotal() here.
 */
class LegacyController
{
    // Route::post('api/v1/legacy', [LegacyController::class, 'store']);

    // TODO: reinstate the 'Acme\Observers\OrderObserver' hook
    public const LISTENERS = [];

    public function show(): Order
    {
        return Order::first();
    }
}
