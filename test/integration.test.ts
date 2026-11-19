import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'pathe'
import { build, createLogger, createServer } from 'vite'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { check, explicitImports, mergeReport, migrate, openSession } from '../src/index'
import type { Finding, Report } from '../src/index'

const scratch: string[] = []
const screen = 'src/pages/index.ts'
const original = 'export const counter = ref(0)\n'
const views = 'src/components/Panel.vue'
const declarations = [
  'export {}',
  "declare global { const ref: typeof import('vue').ref; const local: typeof import('./local').local }",
].join('\n')

function createProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(resolve('test/.tmp-'))
  scratch.push(root)
  for (const [file, contents] of Object.entries({
    'src/auto-imports.d.ts': declarations,
    'src/local.ts': 'export const local = () => 1',
    [screen]: original,
    [views]: '<template><ElButton /></template>',
    'components.d.ts': "declare module 'vue' { export interface GlobalComponents { ElButton: typeof import('element-plus/es').ElButton } }",
    ...files,
  })) {
    const path = resolve(root, file)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  return root
}

function readReport(root: string, path = '.explicit-imports-report.json'): Report {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'))
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('runner and reports', () => {
  test('checks directory and glob filters, honors excludes, and writes the report to a custom path', async () => {
    const root = createProject({ 'src/pages/ignore.ts': 'ref(1)' })
    const session = await openSession({ root, paths: ['src/pages', 'src/components/*.vue'], exclude: ['**/ignore.ts'] })
    const result = check(session, { report: 'reports/result.json' })
    expect(result.report.findings.map(item => item.name)).toEqual(['ElButton', 'ref'])
    expect(result.summary).toEqual({
      total: 2, imports: 1, components: 1, directives: 0,
      directories: {
        'src/components': { total: 1, imports: 0, components: 1, directives: 0 },
        'src/pages': { total: 1, imports: 1, components: 0, directives: 0 },
      },
    })
    expect(readReport(root, 'reports/result.json')).toEqual(result.report)
    expect(check(session, { report: false }).reportFile).toBeUndefined()
    expect(existsSync(resolve(root, '.explicit-imports-report.json'))).toBe(false)

    const first = result.report.findings[0]
    expect(mergeReport(result.report, first.file, []).findings).toEqual(result.report.findings.slice(1))
    const updated: Finding = { ...first, line: 7 }
    expect(mergeReport(result.report, first.file, [updated]).findings).toEqual([updated, result.report.findings[1]])
  })

  test('uses resolved Vite aliases and falls back to tsconfig plus explicit aliases', async () => {
    const root = createProject({
      [screen]: 'local()',
      'vite.config.ts': "import { resolve } from 'node:path'\nexport default { resolve: { alias: { '@vite-source': resolve(import.meta.dirname, 'src') } } }",
      'broken.config.ts': "throw new Error('config failed')",
      'tsconfig.json': '{"compilerOptions":{"paths":{"@fallback/*":["src/*"]}}}',
    })
    const resolved = await openSession({ root, paths: [screen] })
    expect(resolved.configError).toBeUndefined()
    expect(check(resolved, { report: false }).report.findings[0].suggestion).toBe("import { local } from '@vite-source/local'")
    expect(existsSync(resolve(root, 'node_modules/.vite-temp'))).toBe(false)
    const fallback = await openSession({ root, config: 'broken.config.ts', paths: [screen], alias: { '@fallback': 'src' } })
    expect(fallback.configError).toContain('config failed')
    expect(check(fallback, { report: false }).report.findings[0].suggestion).toBe("import { local } from '@fallback/local'")
  })

  test('distinguishes dry-run, written edits, and manual findings', async () => {
    const manual = 'src/pages/Manual.vue'
    const root = createProject({ [manual]: '<script>export default {}</script><template>{{ ref(0) }}</template>' })
    const session = await openSession({ root, paths: ['src/pages'] })
    const preview = migrate(session, { dryRun: true })
    expect(preview).toMatchObject({
      changed: [resolve(root, screen)], fixed: [{ name: 'ref' }], manual: [{ name: 'ref', fixable: false }],
    })
    expect(readFileSync(resolve(root, screen), 'utf8')).toBe(original)
    expect(migrate(session)).toEqual(preview)
    expect(readFileSync(resolve(root, screen), 'utf8')).toBe("import { ref } from 'vue'\n" + original)
    expect(migrate(session)).toMatchObject({ changed: [], fixed: [], manual: [{ name: 'ref' }] })
  })
})

describe('Vite plugin', () => {
  test('warns once for an unchanged file and clears stale findings after a clean transform', async () => {
    const root = createProject({ 'src/entry.js': 'export const value = ref(1)' })
    const logger = createLogger('silent')
    const warn = vi.spyOn(logger, 'warn')
    const report = 'reports/dev.json'
    const server = await createServer({
      root, configFile: false, customLogger: logger, server: { middlewareMode: true, ws: false },
      plugins: [
        {
          name: 'simulate-auto-import', enforce: 'pre',
          transform(code, id) { if (id.endsWith('/entry.js')) return "import { ref } from 'vue'\n" + code },
        },
        explicitImports({ mode: 'warn', report }),
      ],
    })
    try {
      await server.transformRequest('/src/entry.js')
      server.moduleGraph.invalidateAll()
      await server.transformRequest('/src/entry.js')
      expect(warn.mock.calls.filter(([message]) => message.includes('src/entry.js'))).toHaveLength(1)
      await vi.waitFor(() => {
        expect(readReport(root, report)).toMatchObject({ source: 'dev', findings: [{ name: 'ref' }] })
      })
      writeFileSync(resolve(root, 'src/entry.js'), 'export const value = 1')
      server.moduleGraph.invalidateAll()
      await server.transformRequest('/src/entry.js')
      await vi.waitFor(() => expect(readReport(root, report).findings).toEqual([]))
    } finally {
      await server.close()
    }
  })

  test('fails a strict build with a file location, suggestion and migration hint', async () => {
    const root = createProject({ 'src/entry.js': 'export const value = ref(1)' })
    await expect(build({
      root, configFile: false, logLevel: 'silent',
      plugins: [explicitImports({ mode: 'strict' })],
      build: { write: false, rollupOptions: { input: resolve(root, 'src/entry.js') } },
    })).rejects.toThrow(/src\/entry\.js:1:22[\s\S]*import \{ ref \} from 'vue'[\s\S]*vite-vue-explicit-imports migrate/)
    expect(readReport(root)).toMatchObject({ source: 'build', findings: [{ name: 'ref' }] })
  })

  test.each(['warn', 'off'] as const)('finishes a build in %s mode', async mode => {
    const root = createProject({ 'src/entry.js': 'export const value = ref(1)' })
    const logger = createLogger('silent')
    const warn = vi.spyOn(logger, 'warn')
    await build({
      root, configFile: false, customLogger: logger,
      plugins: [explicitImports({ mode, report: mode === 'warn' })],
      build: { write: false, rollupOptions: { input: resolve(root, 'src/entry.js') } },
    })
    const messages = warn.mock.calls.map(([message]) => message).filter(message => message.startsWith('[explicit-imports]'))
    if (mode === 'warn') {
      expect(messages).toHaveLength(2)
      expect(messages[1]).toContain('1 finding(s)')
      expect(readReport(root).source).toBe('build')
    } else {
      expect(messages).toEqual([])
      expect(existsSync(resolve(root, '.explicit-imports-report.json'))).toBe(false)
    }
  })
})

describe('built CLI', () => {
  beforeAll(() => {
    execFileSync('pnpm', ['run', 'build'], { stdio: 'pipe' })
  }, 30_000)

  function invoke(root: string, ...args: string[]) {
    return spawnSync(process.execPath, [resolve('dist/cli.mjs'), ...args, '--root', root], { encoding: 'utf8' })
  }

  test('ships executable entry points and supports check, JSON, explicit reports and exit codes', () => {
    const root = createProject()
    for (const file of ['index.mjs', 'index.d.mts', 'vite.mjs', 'vite.d.mts', 'cli.mjs']) {
      expect(existsSync(resolve('dist', file))).toBe(true)
    }
    expect(readFileSync(resolve('dist/cli.mjs'), 'utf8')).toMatch(/^#!\/usr\/bin\/env node/)
    const checkText = invoke(root, 'check', '--report', 'report/custom.json', '--category', 'imports')
    expect(checkText.status).toBe(1)
    expect(checkText.stdout).toContain('src/pages/index.ts')
    expect(checkText.stdout).toContain('src/pages — 1 total, 1 imports')
    expect(readReport(root, 'report/custom.json').findings).toHaveLength(1)
    const checkJSON = invoke(root, 'check', '--json', '--no-report', 'src/components')
    expect(checkJSON.status).toBe(1)
    expect(JSON.parse(checkJSON.stdout)).toMatchObject({ version: 1, findings: [{ name: 'ElButton' }] })
    expect(existsSync(resolve(root, '.explicit-imports-report.json'))).toBe(false)
    const invalid = invoke(root, 'check', '--category', 'wrong')
    expect(invalid.status).toBe(2)
    expect(invalid.stderr).toContain('Invalid category')
  })

  test('dry-runs migrations then writes changes and exits clean on a new check', () => {
    const root = createProject()
    const preview = invoke(root, 'migrate', '--no-report', '--dry-run', 'src/pages')
    expect(preview.status).toBe(0)
    expect(preview.stdout).toContain('Would update src/pages/index.ts')
    expect(preview.stdout).not.toContain('src/components')
    expect(preview.stdout).toContain('1 file(s), 1 fixable')
    expect(readFileSync(resolve(root, screen), 'utf8')).toBe(original)
    const migration = invoke(root, 'migrate', '--json', 'src/pages')
    expect(migration.status).toBe(0)
    expect(JSON.parse(migration.stdout)).toMatchObject({ changed: [resolve(root, screen)], fixed: [{ name: 'ref' }], manual: [] })
    const verified = invoke(root, 'check', 'src/pages')
    expect(verified.status).toBe(0)
    expect(verified.stdout).toContain('0 total')
  })
})
