# vite-vue-explicit-imports

Give a Vite and Vue 3 project explicit imports for the composables, types, components and directives it currently auto-imports.

With coding agents, syntactic sugar is no longer worth trading explicitness for. Explicit imports show where a symbol comes from, including local overrides. They also let you remove `unplugin-auto-import` and `unplugin-vue-components` once migration is complete. Inspired by [antfu/nuxt-explicit-imports](https://github.com/antfu/nuxt-explicit-imports).

## Install

```sh
pnpm add -D vite-vue-explicit-imports
```

Use Node.js 20.19+ on the 20.x line, or Node.js 22.12+. The Vite plugin supports Vite 5+ and Vue 3.3+.

Install the migration skill for your coding agent.

```sh
npx skills add hdmy/vite-vue-explicit-imports
```

## CLI

Keep the legacy plugins and registry files while migrating. The CLI discovers `.unimport-items.json` or `auto-imports.d.ts`, and `components.d.ts`. It also looks for these declarations and prefixed variants such as `src/web.components.d.ts` under `src/`.

```sh
pnpm exec vite-vue-explicit-imports check
pnpm exec vite-vue-explicit-imports check --no-report --json
pnpm exec vite-vue-explicit-imports migrate --dry-run src/pages
pnpm exec vite-vue-explicit-imports migrate src/pages
pnpm exec vite-vue-explicit-imports check src/pages
```

Both commands accept file, directory and quoted glob filters relative to the root. `check` prints findings and counts per category and directory. Its exit code is 1 when findings remain and 0 when clean. CLI errors use exit code 2. `migrate` lists changes and manual findings. A successful invocation exits 0.

Shared flags include `--root <dir>`, `--config <file>`, `--category <list>`, `--imports-dts <file>`, `--components-dts <file>`, `--unimport-items <file>`, `--ignore-imports <list>`, `--ignore-components <list>`, `--ignore-directives <list>`, `--exclude <list>` and `--json`. Lists are comma-separated. Configure brace-expansion globs through the JavaScript `exclude` option.

`check` writes `.explicit-imports-report.json` at the project root. Override it with `--report <path>` or disable it with `--no-report`. `migrate --dry-run` writes no source changes or report. Config loading is best effort. If it fails, CLI alias resolution uses project tsconfigs and explicit options.

## Vite plugin

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { explicitImports } from 'vite-vue-explicit-imports/vite'

export default defineConfig({
  plugins: [
    explicitImports({ mode: { imports: 'strict', components: 'warn', directives: 'off' } }),
    vue(),
  ],
})
```

- `off` skips that category.
- `warn` reports each finding once per unchanged file. This is the default for each category.
- `strict` fails a transform when the category has a finding.

The plugin reads sources from disk, so earlier transforms cannot hide implicit imports. It writes a report for the files Vite visits. Use `check` for a full inventory. Set `report: false` to skip report output.

| Option | Meaning |
| --- | --- |
| `mode` | One mode for all categories or a per-category map. |
| `root` | Project directory. Defaults to the Vite root in plugin use or the current directory in the CLI. |
| `srcDirs` | Scan roots. Defaults to `['src']` when present and `['.']` otherwise. |
| `exclude` | Extra globs alongside dependency, build, config, declaration and test exclusions. |
| `alias` | Explicit local path aliases, such as `{ '@': 'src' }`. These override discovered aliases with the same key. |
| `unimportItems`, `importsDts`, `componentsDts` | Registry paths relative to the root. A discovered or explicit unimport dump takes priority over the imports declaration. |
| `packageSpecifiers` | Package specifier overrides. Defaults include `element-plus/es` → `element-plus` and `ant-design-vue/es` → `ant-design-vue`. |
| `ignoreImports`, `ignoreComponents`, `ignoreDirectives` | Intentional globals to exclude from migration. |
| `report` | Boolean or report path relative to the root. |

## Before and after

```diff
 <script setup lang="ts">
+import { ref } from 'vue'
+import { definePage } from 'vue-router/experimental'
+import { RouterLink, RouterView } from 'vue-router'
+import { ElButton } from 'element-plus'
+
 definePage({ name: 'home' })
 const count = ref(0)
 </script>

 <template>
   <ElButton @click="count++">{{ count }}</ElButton>
   <RouterLink to="/">Home</RouterLink>
   <RouterView />
 </template>
```

If Element Plus `v-loading` is intentionally global, register it once with `import { ElLoading } from 'element-plus'` and `app.use(ElLoading)` in `src/main.ts`. Configure `ignoreDirectives: ['loading']` or pass `--ignore-directives loading`.

## Remove the legacy plugins

Use the initial `check` counts as a baseline. Migrate and verify one directory at a time, then promote each clean category to `strict`. After a full clean scan, remove the auto-import plugin calls from Vite, Vitest and ESLint configuration where applicable. Uninstall `unplugin-auto-import` and `unplugin-vue-components`. Delete generated `*.auto-imports.d.ts`, `*.components.d.ts`, `.eslintrc-auto-import.json` and `.unimport-items.json` and remove their configuration references. Run your typecheck, tests and build after teardown.

[MIT](LICENSE)
