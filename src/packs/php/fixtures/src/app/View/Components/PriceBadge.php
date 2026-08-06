<?php

namespace Acme\View\Components;

use Acme\Libraries\Price\PriceCalculator;

/**
 * The plain kebab-cased component: <x-price-badge /> in a template, PriceBadge here. Its only
 * incoming edge in this corpus comes from a blade tag, which is the whole point of the fixture:
 * before the template family existed this class read as used by nothing.
 */
class PriceBadge
{
    public function __construct(private PriceCalculator $calculator)
    {
    }

    public function render(): string
    {
        return 'components.price-badge';
    }
}
