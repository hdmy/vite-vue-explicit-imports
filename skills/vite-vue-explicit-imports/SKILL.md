---
name: vite-vue-explicit-imports
description: Migrate a Vite and Vue 3 project from unplugin-auto-import and unplugin-vue-components to explicit imports. Use for inventory, directory-scoped codemods, manual Vue fixes, strict gates, and final plugin removal.
---

# Migrate Vue auto-imports in stages

1. Keep both auto-import plugins and their generated registries in place. Add the explicit-imports Vite plugin in `warn` mode. Locate the import and component declaration files or unimport dump. Pass explicit registry paths when discovery misses them.
2. Run `pnpm exec vite-vue-explicit-imports check --no-report --json` at the project root. Exit code 1 means findings remain. Record counts by directory and category as the baseline. Require those counts to stay at or below baseline during migration, then tighten them as directories become clean. Keep any existing project validation requirements.
3. Preview one directory with `pnpm exec vite-vue-explicit-imports migrate --dry-run src/pages`. Run the same command without `--dry-run` after reviewing the plan. Inspect the diff, check the directory again, and run its relevant typecheck, tests, or build. Repeat for other directories. Use [manual fixes](references/manual-fixes.md) for findings the codemod cannot apply.
4. Once a category is clean across the project, set it to `strict` while other categories stay in `warn`. Promote all categories after a clean full scan and verify both dev and build entry points.
5. Remove the legacy plugin calls from `vite.config.*`, `vitest.config.*` and `eslint.config.*` where configured. Uninstall `unplugin-auto-import` and `unplugin-vue-components`. Delete their generated `*.auto-imports.d.ts`, `*.components.d.ts`, `.eslintrc-auto-import.json` and `.unimport-items.json` and remove references to them. Run the project's typecheck, tests and build with the plugins gone. A scan with missing registries cannot prove that teardown succeeded.

## Project conventions

- If Element Plus `v-loading` is intentionally global, add `import { ElLoading } from 'element-plus'` and `app.use(ElLoading)` once in `src/main.ts`. Then set `ignoreDirectives: ['loading']` or pass `--ignore-directives loading`. Confirm that every relevant app entry point installs it.
- Import `RouterLink` and `RouterView` explicitly with `import { RouterLink, RouterView } from 'vue-router'`.
- Import Vue Router's `definePage` with `import { definePage } from 'vue-router/experimental'`.
- Preserve project overrides from the registry. For example, an `ElMessage` mapped to `@/utils/message` must keep the local wrapper.
