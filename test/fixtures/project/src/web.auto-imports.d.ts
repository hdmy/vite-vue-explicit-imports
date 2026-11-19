export {}
declare global {
  const ref: typeof import('vue').ref
  const computed: typeof import('vue')['computed']
  const ElMessage: typeof import('./utils/message').ElMessage
  const useStore: typeof import('./store')['default']
  const definePage: typeof import('vue-router/experimental').definePage
  const defineProps: typeof import('vue').defineProps
  const defineEmits: typeof import('vue').defineEmits
  const collide: typeof import('vue').ref
  const formatCount: typeof import('./utils/format').default
  type LocalType = import('./utils/types').LocalType
}
export type { Ref as VueRef, ComputedRef } from 'vue'
