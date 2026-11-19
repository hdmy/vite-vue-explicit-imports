# Package conventions

- Keep the public core API in `src/index.ts`. Separate project discovery, registry, analysis and source edits.
- Keep Vitest suites and input fixtures under `test/`. Tests that create project files must clean up their scratch directories.
- Use pnpm and keep generated `dist/`, `node_modules/` and test scratch directories out of source control.
- Ship the migration skill in `skills/vite-vue-explicit-imports/`. Keep the workflow in `SKILL.md` and manual cases in `references/`.
