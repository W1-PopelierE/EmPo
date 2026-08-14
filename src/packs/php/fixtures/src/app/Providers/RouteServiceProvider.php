<?php

namespace Acme\Providers;

use Illuminate\Support\Facades\Route;

class RouteServiceProvider
{
    // The provider half of the file scope: the prefix holds for everything the file it mounts
    // produces, which is the one thing that file cannot answer about itself.
    public function boot(): void
    {
        Route::prefix('api')->middleware('api')->group(base_path('routes/app.php'));
    }
}
