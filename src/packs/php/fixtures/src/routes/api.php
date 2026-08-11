<?php

use Acme\Http\Controllers\OrderController;
use Illuminate\Support\Facades\Route;

Route::post('api/v1/orders', [OrderController::class, 'store']);
Route::get('api/v1/orders/{order}', [OrderController::class, 'show']);

// A route that renders a template with no controller in between, which is a route file's whole
// reason to be a node here: the second argument is the view name and the first is a URL. The
// global `view(` rule refuses this line on purpose — it would capture the URL — so the facade
// spelling gets a rule of its own, and this is the line that fails if either half is dropped.
Route::view('/layout-preview', 'layouts.app');
