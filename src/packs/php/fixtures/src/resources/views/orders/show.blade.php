{{-- The order page. Every tag below names a class by its short name and by nothing else, which is
     what the `short-name` resolve strategy exists for. This file is also the corpus's only
     .blade.php, so it is what selects the pack's compound-extension comment syntax: the engine
     matches the longest declared dotted suffix, because posix.extname answers ".php" here and a
     ".blade.php" key could otherwise never be chosen. --}}
<x-layout.app-shell title="Order">
    <h1>Order {{ $order->reference }}</h1>

    {{-- The plain kebab-cased form. Don't let the apostrophe in this sentence worry you: blade
         declares no stringQuotes, so prose cannot open a literal that swallows the closer. --}}
    <x-price-badge :cents="$order->total_cents" />

    {{-- Dotted, and ambiguous on purpose: Forms\TextInput and Fields\TextInput share a short name
         once the namespace segment is dropped, so this tag resolves to nothing. --}}
    <x-forms.text-input name="note" />

    <livewire:order-status :order="$order" />

    @livewire('order-panel', ['order' => $order])

    {{-- <x-legacy-badge /> --}}
</x-layout.app-shell>
