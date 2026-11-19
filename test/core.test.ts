import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'pathe'
import { parseSync } from 'oxc-parser'
import { afterEach, describe, expect, test } from 'vitest'
import { analyzeFile, applyFixes, loadRegistry, Project, resolveModes } from '../src/index'
import type { ExplicitImportsOptions } from '../src/index'

const fixture = resolve('test/fixtures')
const root = resolve(fixture, 'project')
const scratch: string[] = []

function temporaryProject(files: Record<string, string>): string {
  const directory = mkdtempSync(resolve('test/.tmp-'))
  scratch.push(directory)
  for (const [file, content] of Object.entries(files)) {
    const path = resolve(directory, file)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return directory
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function migrate(file: string, source: string, options: ExplicitImportsOptions = {}) {
  const project = new Project({ root, ...options })
  const registry = loadRegistry(project)
  const result = analyzeFile(file, source, project, registry)
  const output = applyFixes(result)
  const again = analyzeFile(file, output, project, registry)
  expect(again.findings.filter(finding => finding.fixable)).toEqual([])
  expect(applyFixes(again)).toBe(output)
  if (!file.endsWith('.vue')) expect(parseSync(file, output).errors).toEqual([])
  return { findings: result.findings, output }
}

describe('project registry', () => {
  test('resolves category modes and rejects malformed values', () => {
    expect(resolveModes()).toEqual({ imports: 'warn', components: 'warn', directives: 'warn' })
    expect(resolveModes({ components: 'off' })).toEqual({ imports: 'warn', components: 'off', directives: 'warn' })
    expect(resolveModes('strict')).toEqual({ imports: 'strict', components: 'strict', directives: 'strict' })
    expect(() => resolveModes({ imports: 'bad' } as never)).toThrow(/Invalid mode.*imports.*bad/)
  })

  test('discovers JSONC references, precise aliases and excludes', () => {
    const project = new Project({ root, alias: { '@extra': 'src/utils' }, exclude: ['**/ignored.vue'] })
    expect(project.srcDirs).toEqual(['src'])
    expect(project.aliasFor(resolve(root, 'src/components/users/AddUserDialog.vue'), true)).toBe('@ui/users/AddUserDialog.vue')
    expect(project.aliasFor(resolve(root, 'src/utils/index.mts'), false)).toBe('@extra')
    expect(project.aliasFor(resolve(root, 'src/utils/message.ts'), false)).toBe('exact')
    for (const path of ['node_modules/index.ts', 'Something.config.mts', 'Thing.test.vue', 'tests/Thing.vue', 'foo.d.cts', 'ignored.vue']) {
      expect(project.includes('src/' + path)).toBe(false)
    }
    expect(project.includes('src/code.mjs')).toBe(true)
    expect(project.includes('outside.ts')).toBe(false)
  })

  test('loads auto-import declarations and Vue augmentation entries', () => {
    const registry = loadRegistry(new Project({ root, alias: { exact: 'other' } }))
    expect(registry.imports.get('ElMessage')).toMatchObject({ from: '@/utils/message', exportName: 'ElMessage' })
    expect(registry.imports.get('useStore')).toMatchObject({ from: '@/store', exportName: 'default' })
    expect(registry.imports.get('formatCount')).toMatchObject({ from: '@/utils/format', exportName: 'default' })
    expect(registry.imports.get('definePage')).toMatchObject({ from: 'vue-router/experimental' })
    expect(registry.imports.get('VueRef')).toMatchObject({ from: 'vue', exportName: 'Ref', type: true })
    expect(registry.imports.get('LocalType')).toMatchObject({ from: '@/utils/types', exportName: 'LocalType', type: true })
    expect(registry.components.get('add-user-dialog')).toMatchObject({
      pascalName: 'AddUserDialog', kebabName: 'add-user-dialog', exportName: 'default',
      from: '@ui/users/AddUserDialog.vue', filePath: resolve(root, 'src/components/users/AddUserDialog.vue'),
    })
    expect(registry.components.get('ElButton')).toMatchObject({ from: 'element-plus', exportName: 'ElButton' })
    expect(registry.components.get('RouterLink')).toMatchObject({ from: 'vue-router' })
    expect(registry.components.get('RouterView')).toMatchObject({ from: 'vue-router' })
    expect(registry.directives.get('loading')).toMatchObject({ from: 'element-plus', local: 'vLoading', exportName: 'ElLoadingDirective' })
    expect(registry.directives.get('focus')).toMatchObject({ from: '@/directives/focus', local: 'vFocus' })
    expect(registry.directives.get('spin')).toMatchObject({ from: 'ant-design-vue', local: 'vSpin' })
  })

  test('prefers the dump, filters disabled items, and falls back to importer-relative paths', () => {
    const root = temporaryProject({
      '.unimport-items.json': JSON.stringify([
        { name: 'default', as: 'local', from: './utils/local.ts' },
        { name: 'Ref', from: 'vue', type: true },
        { name: 'ref', from: 'vue', disabled: true },
      ]),
      'auto-imports.d.ts': "declare global { const computed: typeof import('vue').computed } export {}",
    })
    const opts = { root }
    const registry = loadRegistry(new Project(opts))
    expect([...registry.imports.keys()]).toEqual(['local', 'Ref'])
    expect(registry.imports.get('Ref')).toMatchObject({ type: true })
    expect(migrate('nested/call.ts', 'local()', opts).output).toBe("import local from '../utils/local'\nlocal()")
  })
})

describe('scripts', () => {
  test('uses type-only imports for type queries, verified by TypeScript under verbatimModuleSyntax', () => {
    const source = "export type Result = typeof ref\nexport type Type = VueRef<LocalType>\n"
    const { output, findings } = migrate('src/types.ts', source)
    expect(findings.map(item => item.kind)).toEqual(['type', 'type', 'type'])
    expect(output).toContain("import type { ref, Ref as VueRef } from 'vue'")
    const dir = temporaryProject({
      'main.ts': output.replace('@/utils/types', './types'),
      'types.ts': 'export interface LocalType {}',
    })
    execFileSync(process.execPath, [
      resolve('node_modules/typescript/bin/tsc'), '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck',
      '--verbatimModuleSyntax', '--module', 'ESNext', '--moduleResolution', 'Bundler',
      '--target', 'ES2022', 'main.ts',
    ], { cwd: dir, stdio: 'pipe' })
  })

  test('promotes mixed usages to runtime, honors hoisting, lexical shadows, and re-exports', () => {
    const source = [
      'type RefFactory = typeof ref',
      'const count = ref(1)',
      'function useLocal(computed: () => number) { return computed() }',
      'function nested() { useStore(); function useStore() {} }',
      'const { formatCount } = props',
      "export { definePage as route } from 'elsewhere'",
      'export type { RefFactory }',
    ].join('\n')
    const { findings, output } = migrate('src/counter.ts', source)
    expect(findings.map(({ name, kind }) => [name, kind])).toEqual([['ref', 'import']])
    expect(output.startsWith("import { ref } from 'vue'\n")).toBe(true)
  })

  test('ignores local files that would import themselves', () => {
    expect(migrate('src/utils/message.ts', 'ElMessage()').findings).toEqual([])
  })

  test.each(['ts', 'tsx', 'js', 'jsx', 'mts', 'mjs'])('migrates a script with .%s extension', ext => {
    expect(migrate('src/source.' + ext, 'ref(1)').output).toContain("import { ref } from 'vue'")
  })

  test.each(['cts', 'cjs'])('reports CommonJS runtime references in .%s', ext => {
    const { findings, output } = migrate('src/source.' + ext, 'module.exports = ref(1)')
    expect(findings).toMatchObject([{ name: 'ref', fixable: false, reason: expect.stringMatching(/CommonJS/) }])
    expect(output).toBe('module.exports = ref(1)')
  })

  test.each([
    ["import {} from 'vue'\n", "import { ref } from 'vue'\n"],
    ["import { computed } from 'vue'\n", "import { computed, ref } from 'vue'\n"],
    ["import { computed, } from 'vue'\n", "import { computed, ref, } from 'vue'\n"],
    ["import {\n  computed,\n} from 'vue'\n", "import {\n  computed,\n  ref,\n} from 'vue'\n"],
    ["import {\n  computed // existing\n} from 'vue'\n", "import {\n  computed, // existing\n  ref\n} from 'vue'\n"],
    ["import {\r\n\tcomputed,\r\n} from 'vue'\r\n", "import {\r\n\tcomputed,\r\n\tref,\r\n} from 'vue'\r\n"],
    ["import { computed /* } */ } from 'vue'\n", "import { computed, ref /* } */ } from 'vue'\n"],
  ])('merges named imports while retaining style %#', (before, after) => {
    expect(migrate('src/index.ts', before + 'ref(1)').output).toBe(after + 'ref(1)')
  })

  test('preserves a shebang, directive prologue, namespace import and trailing comment', () => {
    const source = '#!/usr/bin/env node\n"use client";\nimport * as Vue from "vue"; // namespace\nref(1)'
    const expected = '#!/usr/bin/env node\n"use client";\nimport * as Vue from "vue"; // namespace\nimport { ref } from "vue";\nref(1)'
    expect(migrate('src/entry.ts', source).output).toBe(expected)
    expect(migrate('src/entry.ts', '#!/usr/bin/env node\nref(1)').output)
      .toBe("#!/usr/bin/env node\nimport { ref } from 'vue'\nref(1)")
  })

  test('merges type-only declarations separately from runtime imports', () => {
    const source = "import { computed } from 'vue'\nimport type { App } from 'vue'\nconst count: VueRef<number> = ref(1)"
    expect(migrate('src/index.ts', source).output).toBe(
      "import { computed, ref } from 'vue'\nimport type { App, Ref as VueRef } from 'vue'\nconst count: VueRef<number> = ref(1)",
    )
  })
})

describe('Vue SFCs', () => {
  test('migrates setup scripts, templates, Vue Router components and directives', () => {
    const source = readFileSync(resolve(fixture, 'Setup.vue'), 'utf8')
    const { output, findings } = migrate('src/Setup.vue', source)
    expect(findings.map(item => item.name)).toEqual([
      'definePage', 'ref', 'ElMessage', 'ElButton', 'loading', 'computed', 'AddUserDialog', 'RouterLink', 'RouterView', 'focus',
    ])
    expect(output).toContain("import { shallowRef, ref, computed } from 'vue'")
    expect(output).toContain("import { definePage } from 'vue-router/experimental'")
    expect(output).toContain("import { ElMessage } from 'exact'")
    expect(output).toContain("import { ElButton, ElLoadingDirective as vLoading } from 'element-plus'")
    expect(output).toContain("import { RouterLink, RouterView } from 'vue-router'")
    expect(output).toContain("import AddUserDialog from '@ui/users/AddUserDialog.vue'")
    expect(findings.find(item => item.name === 'loading')).toMatchObject({ line: 12, column: 14 })
    const { descriptor } = parse(output)
    const script = compileScript(descriptor, { id: 'test' })
    const template = compileTemplate({
      source: descriptor.template!.content, filename: 'Setup.vue', id: 'test',
      compilerOptions: { bindingMetadata: script.bindings },
    })
    expect(template.errors).toEqual([])
    expect(template.ast?.components).toEqual([])
    expect(template.ast?.directives).toEqual([])
  })

  test('supports ignore options and category modes', () => {
    const source = '<template><el-button v-loading="true" /> <RouterLink /> {{ ref(1) }}</template>'
    const { findings } = migrate('src/Options.vue', source, {
      ignoreDirectives: ['loading'], ignoreComponents: ['router-link'], mode: { imports: 'off' },
    })
    expect(findings.map(item => item.name)).toEqual(['ElButton'])
  })

  test('never imports the same SFC recursively', () => {
    const file = 'src/components/users/AddUserDialog.vue'
    expect(migrate(file, '<template><add-user-dialog /></template>').findings).toEqual([])
    expect(migrate(file, '<template><AddUserDialog /></template>').findings).toEqual([])
  })

  test('adds setup to template-only TS and JS files, or populates an existing empty block', () => {
    const source = '<template><RouterView /></template>'
    expect(migrate('src/Only.vue', source).output)
      .toBe("<script setup lang=\"ts\">\nimport { RouterView } from 'vue-router'\n</script>\n\n" + source)
    const root = temporaryProject({ 'components.d.ts': "declare module 'vue' { interface GlobalComponents { RouterView: typeof import('vue-router').RouterView } }" })
    expect(migrate('Only.vue', source, { root }).output).toMatch(/^<script setup>\n/)
    expect(migrate('src/Only.vue', '<script setup></script>\n' + source).output.match(/<script setup>/g)).toHaveLength(1)
  })

  test('registers components in Options API and reports bindings requiring manual work', () => {
    const { output, findings } = migrate('src/Options.vue', readFileSync(resolve(fixture, 'Options.vue'), 'utf8'))
    expect(output).toContain('import { ElButton } from "element-plus";')
    expect(output).toContain('import { RouterView } from "vue-router";')
    expect(output).toContain('    Other: {},\n    ElButton,\n    RouterView,\n')
    expect(findings.filter(item => !item.fixable).map(item => item.name)).toEqual(['useStore', 'focus'])
    expect(migrate('src/Options.vue', '<script>export default {}</script>\n<template><ElButton /></template>').output)
      .toContain('export default { components: { ElButton } }')
    expect(migrate('src/Options.vue', '<script>export default { components: external }</script>\n<template><ElButton /></template>').findings)
      .toMatchObject([{ name: 'ElButton', fixable: false }])
  })

  test('shares normal script bindings and deduplicates new imports between blocks', () => {
    const source = [
      '<script lang="ts">',
      'const computed = () => 42',
      'const x = ref(0)',
      "import RouterLink from './RouterLink.vue'",
      '</script>',
      '<script setup lang="ts">',
      'const y = computed() + ref(1).value',
      'defineProps<{ title: string }>()',
      '</script>',
      '<template><RouterLink />{{ computed() }} {{ ref(1) }}</template>',
    ].join('\n')
    const { output, findings } = migrate('src/Dual.vue', source)
    expect(findings.map(item => item.name)).toEqual(['ref'])
    expect(output.match(/import \{ ref \}/g)).toHaveLength(1)
  })

  test('promotes a type query if the template needs a runtime binding', () => {
    const { findings, output } = migrate('src/Mixed.vue',
      '<script setup lang="ts">\ntype Factory = typeof ref\n</script>\n<template>{{ ref(1) }}</template>')
    expect(findings).toMatchObject([{ name: 'ref', kind: 'import', fixable: true }])
    expect(output).toContain("import { ref } from 'vue'")
  })
})

test('shares a runtime component import with a script type query', () => {
  const root = temporaryProject({
    'auto-imports.d.ts': "declare global { const RouterLink: typeof import('vue-router').RouterLink } export {}",
    'components.d.ts': "declare module 'vue' { interface GlobalComponents { RouterLink: typeof import('vue-router').RouterLink } }",
  })
  const source = '<script setup lang="ts">\ntype Link = typeof RouterLink\n</script>\n<template><RouterLink /></template>'
  const { findings, output } = migrate('Link.vue', source, { root })
  expect(findings).toMatchObject([{ kind: 'type', fixable: true }, { kind: 'component', fixable: true }])
  expect(output).toContain("import { RouterLink } from 'vue-router'")
  expect(output).not.toContain('import type')
  const existing = source.replace('type Link = typeof RouterLink', "import type { RouterLink } from 'vue-router'")
  expect(migrate('Link.vue', existing, { root }).findings).toMatchObject([{ kind: 'component', fixable: false }])
})

test('handles TSX component references and Vue dynamic binding arguments', () => {
  const { findings } = migrate('src/render.tsx', 'const render = () => <ElMessage />')
  expect(findings.map(finding => finding.name)).toEqual(['ElMessage'])
  const source = '<template><div :[formatCount]="1" />{{ "_ctx.useStore" }}</template>'
  const { output } = migrate('src/Dynamic.vue', source)
  expect(output).toContain("import formatCount from '@/utils/format'")
  expect(output).not.toContain('import useStore')
})

test('does not mistake braces in import comments for an empty named declaration', () => {
  const source = "import /* {} from */ 'vue'\nref(1)"
  expect(migrate('src/source.ts', source).output)
    .toBe("import /* {} from */ 'vue'\nimport { ref } from 'vue'\nref(1)")
})

describe('Phase 1 review regressions', () => {
  test('discovers runtime-core and global component/directive augmentations', () => {
    const root = temporaryProject({
      'components.d.ts': [
        "declare module '@vue/runtime-core' { interface GlobalComponents { ElButton: typeof import('element-plus/es').ElButton } }",
        "declare global { interface GlobalDirectives { vLoading: typeof import('element-plus/es').ElLoadingDirective } }",
        "declare module 'unrelated' { interface GlobalComponents { Wrong: typeof import('unrelated').Wrong } }",
        'export {}',
      ].join('\n'),
    })
    const { findings } = migrate('View.vue', '<template><ElButton v-loading /><Wrong /></template>', { root })
    expect(findings.map(item => item.name)).toEqual(['ElButton', 'loading'])
  })

  test('registers an imported Options API component without duplicating the import', () => {
    const source = '<script lang="ts">\nimport { ElButton } from "element-plus"\nexport default (defineComponent({}) as object)\n</script>\n<template><ElButton /></template>'
    const { output, findings } = migrate('src/Existing.vue', source)
    expect(output).toContain('defineComponent({ components: { ElButton } })')
    expect(output.match(/import \{ ElButton \}/g)).toHaveLength(1)
    expect(findings).toMatchObject([{ suggestion: 'Register ElButton in components', fixable: true }])
  })

  test.each([
    "defineProps<{ formatCount: number }>()",
    "defineProps(['formatCount'])",
    "import type { External } from './external'\nwithDefaults(defineProps<External & { formatCount?: number }>(), { formatCount: 0 })",
    "import type { External } from './external'\ninterface Own extends External { formatCount?: number }\nconst props = withDefaults(defineProps<Own>(), {})",
  ])('respects template props exposed by %s', script => {
    const { findings } = migrate('src/Props.vue',
      '<script setup lang="ts">\n' + script + '\n</script>\n<template>{{ formatCount }} {{ ref(1) }}</template>')
    expect(findings.map(item => item.name)).toEqual(['ref'])
  })

  test('imports a dynamic component from a template expression', () => {
    const { findings, output } = migrate('src/Dynamic.vue', '<template><component :is="ElButton" /></template>')
    expect(findings).toMatchObject([{ category: 'components', name: 'ElButton', fixable: true }])
    expect(output).toContain("import { ElButton } from 'element-plus'")
  })

  test('inherits baseUrl across extends and prefers more specific configs', () => {
    const root = temporaryProject({
      'configs/base.json': '{"compilerOptions":{"baseUrl":"../src"}}',
      'configs/intermediate.json': '{"extends":"./base.json"}',
      'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./old/*"]}}}',
      'tsconfig.web.json': '{"extends":"./configs/intermediate.json","compilerOptions":{"paths":{"@/*":["./web/*"]}}}',
    })
    const project = new Project({ root })
    expect(project.resolveLocal('@/widget', root)).toBe(resolve(root, 'src/web/widget'))
    const explicit = new Project({ root, alias: { '@/': 'src/override/' } })
    expect(explicit.aliasFor(resolve(root, 'src/override/widgets.ts'), false)).toBe('@/widgets')
  })

  test('uses exact aliases for extensionless declaration specifiers', () => {
    const { output } = migrate('src/use.ts', 'ElMessage()')
    expect(output).toBe("import { ElMessage } from 'exact'\nElMessage()")
  })

  test('only treats the query target as a value namespace lookup inside typeof', () => {
    const source = 'type Result = typeof ref<VueRef.Bar>\n'
    const { findings, output } = migrate('src/Query.ts', source)
    expect(findings).toMatchObject([{ name: 'ref', fixable: true }, { name: 'VueRef', fixable: true }])
    expect(output).toContain("import type { ref, Ref as VueRef } from 'vue'")
  })

  test('puts promoted runtime imports in the normal block when shared across both scripts', () => {
    const source = '<script lang="ts">\nexport type RefFactory = typeof ref\n</script>\n<script setup lang="ts">\nconst count = ref(1)\n</script>\n<template>{{ count }}</template>'
    const { output } = migrate('src/Promotion.vue', source)
    expect(output).toContain("<script lang=\"ts\">\nimport { ref } from 'vue'\nexport type")
    expect(output.match(/import \{ ref \}/g)).toHaveLength(1)
  })

  test('recognizes same-file /index and JavaScript specifiers without files on disk', () => {
    const root = temporaryProject({
      '.unimport-items.json': JSON.stringify([
        { name: 'localIndex', from: './src/module' },
        { name: 'localJS', from: './src/local.js' },
      ]),
    })
    expect(migrate('src/module/index.ts', 'localIndex()', { root }).findings).toEqual([])
    expect(migrate('src/local.ts', 'localJS()', { root }).findings).toEqual([])
  })

  test.each([{ name: 'ref', as: '' }, { name: '*' }, { name: 'default' }])('rejects malformed dump aliases %#', item => {
    const root = temporaryProject({ '.unimport-items.json': JSON.stringify([{ from: 'vue', ...item }]) })
    expect(() => loadRegistry(new Project({ root }))).toThrow(/Invalid unimport item/)
  })

  test('uses existing setup indentation for its first import', () => {
    const source = '<script setup lang="ts">\n  const count = ref(0)\n</script>\n<template>{{ count }}</template>'
    expect(migrate('src/Indented.vue', source).output).toContain("\n  import { ref } from 'vue'\n  const count")
  })
})

test('keeps the runtime registry entry when a declaration also re-exports it as a type', () => {
  const root = temporaryProject({
    'auto-imports.d.ts': "declare global { const ApiError: typeof import('./errors').ApiError }\nexport type { ApiError } from './errors'",
  })
  const result = migrate('src/Use.ts', 'throw new ApiError()', { root })
  expect(result.findings).toMatchObject([{ kind: 'import', fixable: true }])
  expect(result.output).toContain("import { ApiError } from '../errors'")
})

test('does not treat inline import type qualifiers as implicit imports', () => {
  const source = "type A = import('vue').VueRef\ntype B = typeof import('vue').ref\ntype C = import('vue').VueRef.Foo"
  expect(migrate('src/Inline.ts', source).findings).toEqual([])
})
