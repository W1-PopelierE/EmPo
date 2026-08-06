<script setup lang="ts">
import { formatMoney, type Money } from "../shared/money";

const props = defineProps<{ amount: Money }>();
</script>

<template>
  <span class="cart-badge">{{ formatMoney(props.amount) }}</span>
</template>
