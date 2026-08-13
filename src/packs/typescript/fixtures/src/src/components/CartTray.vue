<script setup lang="ts">
import CartFlag from "./cartFlag.vue";
import { formatMoney, type Money } from "../shared/money";

const props = defineProps<{ total: Money }>();
</script>

<template>
  <!--
  The one reference in this corpus that only the case fold can resolve, and it exists to keep the
  fold under a gate rather than to add coverage of Vue.

  A single-file component exports nothing this pack's symbolPattern matches, so cartFlag.vue yields
  a file-level node named by its basename, `cartFlag`. The tag below is spelled `CartFlag`, so the
  exact short-name map holds nothing for it and only the fold on the lower-cased name reaches the
  node. Every other tag in this corpus is answered by the exact map, because under per-export ids a
  React component and the export it names are spelled the same way, so gutting `foldedCandidates`
  used to leave the snapshot byte-identical. It no longer does.

  The import above is load-bearing twice over. It is what the fold's corroboration witness asks for,
  the rendering file having said which module it means, so without it the fold refuses. And it is
  the naming convention this whole fallback exists for: a repository writing lowerCamelCase file
  names while rendering PascalCase tags.
  -->
  <CartFlag :amount="props.total" />
  <p>{{ formatMoney(props.total) }}</p>
</template>
