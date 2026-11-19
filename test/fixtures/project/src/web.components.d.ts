export {}
declare module 'vue' {
  export interface GlobalComponents {
    AddUserDialog: typeof import('./components/users/AddUserDialog.vue')['default']
    ElButton: typeof import('element-plus/es')['ElButton']
    RouterLink: typeof import('vue-router')['RouterLink']
    RouterView: typeof import('vue-router')['RouterView']
    vLoading: typeof import('element-plus/es')['ElLoadingDirective']
  }
  export interface ComponentCustomDirectives {
    'v-focus': typeof import('./directives/focus')['default']
  }
  export interface GlobalDirectives {
    vSpin: typeof import('ant-design-vue/es')['vSpin']
  }
}
