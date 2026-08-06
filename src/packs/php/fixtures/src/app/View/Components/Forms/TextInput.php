<?php

namespace Acme\View\Components\Forms;

/**
 * Half of the ambiguity pair. <x-forms.text-input> folds to the short name TextInput, and so does
 * <x-fields.text-input>, because the namespace segment is dropped before the lookup. Two nodes then
 * share one short name and the strategy refuses rather than guessing, exactly as `observer` does.
 *
 * Keeping the ambiguity in the corpus is deliberate: it is the commonest shape a real Laravel
 * component library has, and a fixture where every tag resolves would report a rate this pack
 * cannot deliver.
 */
class TextInput
{
    public function render(): string
    {
        return 'components.forms.text-input';
    }
}
