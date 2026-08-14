<?php

use Illuminate\Support\Facades\Route;

// The file half of the provider scope. Nothing here says these routes live under api/, because
// nothing here can: the prefix is set by app/Providers/RouteServiceProvider.php, which names this
// file. Read alone, every path below is short by a segment and still a well-formed route.
Route::get('ping', fn () => null);

// The middle link of the chain: this file is named by the provider and names another in turn, so
// the prefix below is only the second segment. Nothing in either file says the routes it mounts
// answer under api/admin/, and a scope that followed one link would key them short by that segment.
Route::prefix('admin')->group(base_path('routes/app_admin.php'));
