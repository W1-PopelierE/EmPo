<?php

namespace Acme\Http\Controllers;

class OrderPageController
{
    public function show(int $order): mixed
    {
        // The page name is a string, and the file it names lives in another root, in another
        // language, under a directory neither file mentions. Only the inertia-page bridge sees it.
        return \Inertia\Inertia::render('Orders/Show', [
            'order' => $order,
            'total' => ['cents' => 1210, 'currency' => 'EUR'],
        ]);
    }
}
