<?php

use Illuminate\Support\Facades\Route;

// The far end of the chain. Two files away from the provider that sets api/, one from the file that
// sets admin/, and read alone this route looks like it answers at flags. Both prefixes must reach
// it, in the order the URL writes them.
Route::get('flags', fn () => null);
