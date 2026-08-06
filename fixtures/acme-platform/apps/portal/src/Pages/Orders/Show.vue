<script setup lang="ts">
import OrderTotal from "../../components/OrderTotal.vue";

// Nothing in this file names the controller that renders it, and nothing in that controller names
// this path. The only thing joining them is the page name the inertia-page bridge derives from
// where this file sits: apps/portal/src/Pages/Orders/Show.vue -> "Orders/Show".
const props = defineProps<{ total: { cents: number; currency: string } }>();
</script>

<template>
  <main class="order-page">
    <h1>Your order</h1>
    <OrderTotal :total="props.total" />
  </main>
</template>
