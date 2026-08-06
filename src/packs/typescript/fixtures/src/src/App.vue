<script setup lang="ts">
import CartPanel from "./components/CartPanel.vue";
</script>

<template>
  <main>
    <CartPanel :total="{ cents: 0, currency: 'EUR' }" :lines="[]" />
  </main>
</template>
