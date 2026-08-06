<?php

namespace Acme\Livewire;

use Acme\Models\Order;

/** Mounted as <livewire:order-status />, the tag spelling. */
class OrderStatus
{
    public function mount(Order $order): void
    {
    }

    public function render(): string
    {
        return 'livewire.order-status';
    }
}
