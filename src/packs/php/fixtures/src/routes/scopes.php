<?php

use Acme\Http\Controllers\OrderController;
use Illuminate\Support\Facades\Route;

// The fluent balanced scope: the prefix holds for everything written inside the braces group()
// opens, so this route is registered at shop/crates and not at crates.
Route::prefix('shop')->group(function () {
    Route::get('crates', fn () => null);
});

// The same fluent form with the prefix not first in the chain, which is how a real Laravel app
// writes it. Links before and after the prefix must not stop the rule from finding it.
Route::middleware('auth')->prefix('billing')->namespace('Billing')->group(function () {
    Route::get('invoices', fn () => null);
});

// The multi-line chain, with -> at the start of each line and a static closure with a return type.
// A rule anchored to a single line reads this group as no group at all.
Route::prefix('reports')
    ->name('reports.')
    ->group(static function (): void {
        Route::get('daily', fn () => null);
    });

// The array form: the prefix is an option in the array rather than a link in a chain.
Route::group(['middleware' => ['auth'], 'prefix' => 'ops', 'as' => 'ops.'], function () {
    Route::get('health', fn () => null);
});

// The array form with the array on its own lines and a nested array after the prefix, which is the
// spelling a naive one-line regex misses: the first ] below closes ['auth'], not the option array.
Route::group(
    [
        'prefix'     => 'imports',
        'middleware' => ['auth'],
    ],
    function () {
        Route::get('batches', fn () => null);
    }
);

// Nested prefixes: both hold, outermost first, so the key carries them in the order the URL does.
// Reporting only the inner one would produce a key that is wrong and still looks like a route.
Route::prefix('admin')->group(function () {
    Route::prefix('settings')->group(function () {
        Route::get('flags', fn () => null);
    });
});

// The negative test. This group exists but sets no prefix, so the route inside it must be
// registered at unprefixed: a group is not by itself a segment.
Route::namespace('Legacy')->middleware('auth')->group(function () {
    Route::get('unprefixed', fn () => null);
});

// The resource forms, each one route line standing in for the whole set of routes Laravel
// registers under it.
Route::resource('crates', OrderController::class);
Route::apiResource('pallets', OrderController::class);

// The second negative test, and the one that pins where the extent ends: the route below the
// closing brace is outside the group and must not carry its prefix.
Route::prefix('closed')->group(function () {
    Route::get('inside', fn () => null);
});
Route::get('after-the-group', fn () => null);

// The comment mask applies to scopes as well as to edges. The group on the line below is spelled
// exactly, opening brace and all, so a scan that reads this file before the comments are blanked
// gives the live route under it a prefix nothing in the running app ever sets.
// Route::prefix('dead')->group(function () {
Route::get('masked', fn () => null);

// A resource narrowed to all but `show`. The general resource rule refuses it through a lookahead,
// so the seven URLs below are the whole of what it registers: no `GET pallets/*`, which is the one
// the narrowing removed and which the unnarrowed rule would have claimed.
Route::resource('parcels', OrderController::class)->except(['show']);

// A narrowing this pack does not read. Producing the seven anyway would put URLs in the graph that
// return 404, so it produces nothing and the resource is simply absent, which is the floor.
Route::resource('crates-limited', OrderController::class)->only(['index']);
