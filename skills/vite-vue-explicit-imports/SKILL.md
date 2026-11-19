---
name: vite-vue-explicit-imports
description: Migrate a Vite and Vue 3 project from unplugin-auto-import and unplugin-vue-components to explicit imports. Use for inventory, directory-scoped codemods, manual Vue fixes, strict gates, and final plugin removal.
---

# Migrate Vue auto-imports in stages

1. Keep the legacy plugins and generated registries during migration. Add the explicit-imports Vite plugin in `warn` mode. Generate or commit the required registries before scans and `strict` builds on CI or a clean checkout. Pass explicit registry paths when discovery misses them and `--config <file>` for non-default Vite configs, for example `--config vite.web.config.mts`. Before passing `--external-styles <pkg>` or setting `externalStyles`, confirm theme CSS or a style plugin such as `unplugin-element-plus` in every entry point, including main and offline entry points.
2. Run `pnpm exec vite-vue-explicit-imports check --no-report --json` at the project root. Exit code 1 means findings remain and 2 means the scan failed. Record counts by directory and category as the baseline. Require those counts to stay at or below baseline and tighten them as directories become clean.
3. Preview one directory with `pnpm exec vite-vue-explicit-imports migrate --dry-run src/pages`, then apply the reviewed changes. Inspect the diff, re-run `check src/pages`, and run the repo's linter autofix on changed files, for example `pnpm exec eslint --fix <changed-files>`. Run both typecheck and unit tests, for example `pnpm typecheck` and `pnpm test:unit`, then build the target entry points. Use the repo's equivalent scripts where names differ. Treat all these checks as the per-batch acceptance gate. Consult [manual fixes](references/manual-fixes.md) for findings the codemod leaves open.
4. Once a category is clean across the project, set it to `strict` while other categories stay in `warn`. Promote all relevant categories after a clean full scan and verify both dev and build entry points.
5. Remove the legacy plugin calls from `vite.config.*`, `vitest.config.*` and `eslint.config.*` where configured. Uninstall `unplugin-auto-import` and `unplugin-vue-components`. Remove the migration guard or disable its categories before deleting `*.auto-imports.d.ts`, `*.components.d.ts`, `.eslintrc-auto-import.json` and `.unimport-items.json`. Remove references to the generated files and run the project's typecheck, unit tests and builds after teardown.

## Project conventions

- If Element Plus `v-loading` is intentionally global, add `import { ElLoading } from 'element-plus'` and `app.use(ElLoading)` once in `src/main.ts`. Then set `ignoreDirectives: ['loading']` or pass `--ignore-directives loading`. Confirm that every relevant app entry point installs it.
- Import `RouterLink` and `RouterView` explicitly with `import { RouterLink, RouterView } from 'vue-router'`.
- Import Vue Router's `definePage` with `import { definePage } from 'vue-router/experimental'`.
- Preserve project overrides from the registry. For example, an `ElMessage` mapped to `@/utils/message` must keep the local wrapper.
