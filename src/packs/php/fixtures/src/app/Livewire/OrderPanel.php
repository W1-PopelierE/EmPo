<?php

namespace Acme\Livewire;

/**
 * Mounted as @livewire('order-panel'), the directive spelling that predates the tag. It has its own
 * class in this corpus rather than sharing OrderStatus, because dedupeEdges keys on from/to/kind:
 * two spellings pointing at one class would collapse to a single edge and the second rule would be
 * invisible in the snapshot while doing nothing.
 */
class OrderPanel
{
    public function render(): string
    {
        return 'livewire.order-panel';
    }
}
