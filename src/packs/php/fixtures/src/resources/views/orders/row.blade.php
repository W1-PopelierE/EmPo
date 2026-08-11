{{-- One row of the order page, included rather than extended. Two spellings, one strategy: a
     partial and a layout are both a template reached by name. --}}
<tr>
    <td>{{ $line->description }}</td>
    <td><x-price-badge :cents="$line->cents" /></td>
</tr>
