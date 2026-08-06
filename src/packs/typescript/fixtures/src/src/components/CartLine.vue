<script setup lang="ts">
import { formatMoney, type Money } from "../shared/money";

const props = defineProps<{ amount: Money }>();
</script>

<template>
  <li class="cart-line">{{ formatMoney(props.amount) }}</li>
</template>
