<?php

namespace Acme\Http\Controllers;

use Acme\Models\Order;

class AdminController
{
    public function index(): array
    {
        $pending = new Order();

        return ['pending' => $pending->subtotal];
    }
}
