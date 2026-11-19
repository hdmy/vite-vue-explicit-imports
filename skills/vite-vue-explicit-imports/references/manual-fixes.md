# Manual fixes

- **Options API expression**. Import the symbol and expose it to the template via `setup()`, `computed`, `methods` or `data` as appropriate. Keep invocation timing and reactive ownership intact.
- **Options API component**. Register the imported component in the final `components` object. If the object comes from a spread or factory, inspect its merge order before editing.
- **Options API directive**. Import it and register its template name in `directives`. For globally installed Element Plus `v-loading`, add `import { ElLoading } from 'element-plus'` and `app.use(ElLoading)` once in `src/main.ts`, then configure `ignoreDirectives: ['loading']` or `--ignore-directives loading`.
- **Binding conflict**. Check if the existing binding is a type import, an unrelated value or an intentional local override. Preserve the intended binding and use an explicit alias if separate local names are needed.
- **CommonJS runtime reference**. Use the file's existing CommonJS convention. Check that the target supports `require`, or choose a compatible dynamic import.
- **Unsupported or externally sourced SFC block**. Edit the referenced source or use the block's compiler conventions. Verify the compiled component.
