<script setup lang="ts">
import { shallowRef } from 'vue'
const props = defineProps<{ title: string }>()
defineEmits(['close'])
definePage({ name: 'users' })
const count = ref(0)
const ready = Boolean(count)
ElMessage(props.title)
</script>

<template>
  <el-button v-loading="!ready">{{ computed(() => count) }}</el-button>
  <AddUserDialog v-if="ready" />
  <RouterLink to="/" />
  <router-view />
  <div v-focus>{{ ref('already found in script') }}</div>
  <div v-for="formatCount in [1]" :key="formatCount">{{ formatCount }}</div>
  <div>{{ '_ctx.useStore' }}</div>
</template>
