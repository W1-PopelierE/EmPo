<?php

use Acme\Http\Controllers\OrderController;
use Illuminate\Support\Facades\Route;

Route::post('api/v1/orders', [OrderController::class, 'store']);
Route::get('api/v1/orders/{order}', [OrderController::class, 'show']);
