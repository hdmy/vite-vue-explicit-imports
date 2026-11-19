<script lang="ts">
import { defineComponent } from "vue";
export default defineComponent({
  components: {
    Other: {},
  },
  directives: { loading: {} },
  data() {
    return { ref: 'local data' }
  },
})
</script>

<template>
  <el-button v-loading="true">{{ useStore() }} {{ ref }}</el-button>
  <RouterView v-focus />
</template>
