<?php

namespace Acme\View\Components;

/**
 * Referenced only from inside a {{-- --}} comment in orders/show.blade.php, so it must end the
 * build with no incoming edge at all. That is what proves the blade masking half of this pack:
 * .blade.php declares its own comment syntax, and without it the tag inside that comment would
 * become an edge citing a comment, which is the failure mode engine/mask.ts exists to prevent.
 */
class LegacyBadge
{
    public function render(): string
    {
        return 'components.legacy-badge';
    }
}
