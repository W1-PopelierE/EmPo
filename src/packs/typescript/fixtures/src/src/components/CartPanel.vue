<script setup lang="ts">
import { formatMoney, type Money } from "../shared/money";
import CartLine from "./CartLine.vue";

const props = defineProps<{ total: Money; lines: Money[] }>();
</script>

<template>
  <section class="cart-panel">
    <!--
    The panel used to render the row itself:
    import { PriceRow } from "../components/PriceRow";
    -->
    <CartLine v-for="line in props.lines" :key="line.cents" :amount="line" />
    <!-- CartBadge is registered globally, so this tag is the only reference to it anywhere. -->
    <CartBadge :amount="props.total" />
    <a href="https://acme.test/help/cart">Help</a>
    <p>{{ formatMoney(props.total) }}</p>
  </section>
</template>
