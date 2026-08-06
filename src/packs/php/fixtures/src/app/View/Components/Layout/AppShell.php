<?php

namespace Acme\View\Components\Layout;

/**
 * The dotted form: <x-layout.app-shell> names the namespace segment and the component, and only
 * the last segment is this class's own name. `last-dot-segment` before `pascal-case` is what turns
 * the one spelling into the other, and both are pack data.
 */
class AppShell
{
    public function render(): string
    {
        return 'components.layout.app-shell';
    }
}
