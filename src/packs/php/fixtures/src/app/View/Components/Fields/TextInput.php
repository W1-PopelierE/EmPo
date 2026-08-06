<?php

namespace Acme\View\Components\Fields;

/** The other half of the ambiguity pair. See Forms\TextInput for why both exist. */
class TextInput
{
    public function render(): string
    {
        return 'components.fields.text-input';
    }
}
