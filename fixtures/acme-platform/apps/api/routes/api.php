<?php

use Acme\Http\Controllers\CheckoutController;
use Acme\Http\Controllers\OrderController;

Route::post('/v1/orders', [OrderController::class, 'store']);
Route::post('/v1/checkout', [CheckoutController::class, 'confirm']);
Route::get('/v1/orders/{order}', [OrderController::class, 'show']);

// Written fully qualified rather than through a use statement: a fourth import at the top of this
// file would move every Route line under it, and the pricing spine cites line 6 of this file.
Route::get('/orders/{order}', [\Acme\Http\Controllers\OrderPageController::class, 'show']);
