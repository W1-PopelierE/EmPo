{{-- The order page. Every tag below names a class by its short name and by nothing else, which is
     what the `short-name` resolve strategy exists for, and every directive names a template by a
     path below the view root, which is what `view` exists for. A .blade.php is also what selects
     the pack's compound-extension comment syntax: the engine
     matches the longest declared dotted suffix, because posix.extname answers ".php" here and a
     ".blade.php" key could otherwise never be chosen. --}}
@extends('layouts.app')

<x-layout.app-shell title="Order">
    <h1>Order {{ $order->reference }}</h1>

    {{-- A partial by name. Dotted at the call site and slashed on disk, which `dot-to-slash` is
         what closes: the engine holds the verb and the pack holds the sentence. --}}
    @include('orders.row')

    {{-- @each names its template first and @includeWhen names a condition first, so only the
         spellings whose view name is the first argument are in the rule's alternation. --}}
    @each ('orders.row', $order->lines, 'line')

    {{-- A view this corpus does not hold, so it is in no node and resolves to nothing. The refusal
         is counted rather than silent, which is the whole reason the numbers beside `resolved`
         exist: a strategy that resolves nothing must not look like a corpus with nothing to find.
         (A framework-namespaced name like `mail::message` is not written here on purpose — the
         pack's pattern does not match one at all, so it is never read and never counted, rather
         than counted as a loss nobody could repair.) --}}
    @include('orders.archived')

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
