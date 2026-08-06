<script setup lang="ts">
const props = defineProps<{ total: { cents: number; currency: string } }>();

function formatMoney(total: { cents: number; currency: string }): string {
  return (total.cents / 100).toFixed(2) + " " + total.currency;
}
</script>

<template>
  <p class="order-total">{{ formatMoney(props.total) }}</p>
</template>
