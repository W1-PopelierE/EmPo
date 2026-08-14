<?php

use Illuminate\Support\Facades\Route;

// The file half of the provider scope. Nothing here says these routes live under api/, because
// nothing here can: the prefix is set by app/Providers/RouteServiceProvider.php, which names this
// file. Read alone, every path below is short by a segment and still a well-formed route.
Route::get('ping', fn () => null);
