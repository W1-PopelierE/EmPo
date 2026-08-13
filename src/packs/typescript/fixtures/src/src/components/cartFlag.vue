<script setup lang="ts">
import { formatMoney, type Money } from "../shared/money";

const props = defineProps<{ amount: Money }>();
</script>

<template>
  <b class="cart-flag">{{ formatMoney(props.amount) }}</b>
</template>
