<?php

namespace Acme\Http\Controllers;

use Acme\Libraries\Price\PriceCalculator;

class CheckoutController
{
    private PriceCalculator $prices;

    public function confirm(PriceCalculator $prices): string
    {
        $this->prices = $prices;

        // the confirmation mail is queued here once the totals are settled
        return 'confirmed';
    }
}
