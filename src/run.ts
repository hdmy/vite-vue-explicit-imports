import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { isAbsolute, relative, resolve } from 'pathe'
import picomatch from 'picomatch'
import type { ResolvedConfig } from 'vite'
import { analyzeFile } from './analyze'
import { applyFixes } from './fix'
import { Project } from './project'
import { assertRegistryReady, loadRegistry } from './registry'
import type { Registry } from './registry'
import { countFindings, reportPath, sortFindings, summarizeByDirectory, writeReport } from './report'
import type { ExplicitImportsOptions, Finding, Report } from './types'

export interface SessionOptions extends ExplicitImportsOptions {
  config?: string
  paths?: string[]
}

export interface Session {
  project: Project
  registry: Registry
  files: string[]
  configError?: string
}

export function normalizeViteAliases(aliases: ResolvedConfig['resolve']['alias'], root: string): Record<string, string> {
  const paths = new Map<string, string>()
  for (const { find, replacement, customResolver } of aliases) {
    if (typeof find !== 'string' || !find || customResolver || paths.has(find)) continue
    if (isAbsolute(replacement) || replacement.startsWith('.')) paths.set(find, resolve(root, replacement))
  }
  return Object.fromEntries(paths)
}

export async function openSession(options: SessionOptions = {}): Promise<Session> {
  const root = resolve(options.root ?? process.cwd())
  const configFile = options.config === undefined
    ? ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs'].map(ext => resolve(root, `vite.config.${ext}`)).find(existsSync)
    : resolve(root, options.config)
  let viteAliases: Record<string, string> = {}
  let configError: string | undefined
  if (configFile) {
    try {
      // Prefer the project's Vite version when it can be resolved from the config.
      const vite = await (async () => {
        const require = createRequire(configFile)
        let entry: string
        try { entry = require.resolve('vite') } catch { return import('vite') }
        return import(pathToFileURL(entry).href) as Promise<typeof import('vite')>
      })()
      const viteApi = typeof vite.resolveConfig === 'function' ? vite : (vite as unknown as { default: typeof vite }).default
      const major = Number.parseInt(viteApi.version, 10)
      const config = major >= 6
        ? await viteApi.resolveConfig({ root, configFile, configLoader: 'runner' }, 'serve')
        : await resolveVite5Config(viteApi, root, configFile)
      viteAliases = normalizeViteAliases(config.resolve.alias, config.root)
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error)
    }
  }
  const project = new Project({ ...options, root, alias: { ...viteAliases, ...options.alias } })
  const registry = loadRegistry(project)
  assertRegistryReady(project, registry)
  const files = project.sourceFiles()
  const filters = options.paths?.map(path => {
    const absolute = resolve(root, path)
    const matches = picomatch(relative(root, absolute), { dot: true })
    return (file: string) => file === absolute || file.startsWith(absolute.endsWith('/') ? absolute : absolute + '/')
      || matches(relative(root, file))
  })
  return {
    project, registry,
    files: filters?.length ? files.filter(file => filters.some(matches => matches(file))) : files,
    configError,
  }
}

async function resolveVite5Config(vite: typeof import('vite'), root: string, file: string) {
  // Vite 5 has no in-memory runner. Let Node load the config and ask Vite to resolve it.
  const module = await import(pathToFileURL(file).href)
  const config = typeof module.default === 'function'
    ? await module.default({ command: 'serve', mode: 'development', isSsrBuild: false, isPreview: false })
    : await module.default
  return vite.resolveConfig({ ...config, root, configFile: false }, 'serve')
}

export function check(session: Session, options: Pick<ExplicitImportsOptions, 'report'> = {}) {
  const { project, registry, files } = session
  const findings = sortFindings(files.flatMap(file => analyzeFile(file, readFileSync(file, 'utf8'), project, registry).findings))
  const report: Report = { version: 1, generatedAt: new Date().toISOString(), source: 'check', modes: project.modes, findings }
  const setting = options.report ?? project.options.report
  const reportFile = setting === false ? undefined : reportPath(project.root, typeof setting === 'string' ? setting : undefined)
  if (reportFile) writeReport(reportFile, report)
  return {
    report, reportFile,
    summary: { ...countFindings(findings), directories: summarizeByDirectory(findings, project.root) },
  }
}

export function migrate(session: Session, { dryRun = false }: { dryRun?: boolean } = {}) {
  const { project, registry, files } = session
  const changed: string[] = []
  const fixed: Finding[] = []
  const manual: Finding[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const analysis = analyzeFile(file, source, project, registry)
    const output = applyFixes(analysis)
    if (output !== source) {
      if (!dryRun) writeFileSync(file, output)
      changed.push(file)
    }
    for (const finding of analysis.findings) (finding.fixable ? fixed : manual).push(finding)
  }
  return { changed, fixed: sortFindings(fixed), manual: sortFindings(manual) }
}
