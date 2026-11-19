import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'pathe'
import type { Plugin, ResolvedConfig } from 'vite'
import { analyzeFile } from './analyze'
import { Project } from './project'
import { assertRegistryReady, isRegistryFile, loadRegistry } from './registry'
import type { Registry } from './registry'
import { countFindings, formatFileLine, reportPath, writeReport } from './report'
import { normalizeViteAliases } from './run'
import { CATEGORIES } from './types'
import type { ExplicitImportsOptions, Finding, Report } from './types'

function existingFindings(file: string): Finding[] {
  if (!existsSync(file)) return []
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    if (saved?.version !== 1 || !Array.isArray(saved.findings)) return []
    return saved.findings.filter((finding: Finding) => finding && typeof finding.file === 'string'
      && Number.isInteger(finding.line) && Number.isInteger(finding.column)
      && CATEGORIES.includes(finding.category) && ['import', 'type', 'component', 'directive'].includes(finding.kind)
      && typeof finding.name === 'string' && typeof finding.suggestion === 'string' && typeof finding.fixable === 'boolean'
      && (finding.reason === undefined || typeof finding.reason === 'string'))
  } catch {
    return []
  }
}

export function explicitImports(options: ExplicitImportsOptions = {}): Plugin {
  let project: Project
  let registry: Registry | undefined
  let log: ResolvedConfig['logger']
  let report: Omit<Report, 'findings'>
  let output: string | undefined
  let summarized = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const pendingUpdates = new Map<string, Finding[]>()
  const warned = new Map<string, Set<string>>()
  const buildWarnings = new Map<string, Finding[]>()

  function flush(): void {
    clearTimeout(timer)
    timer = undefined
    if (!output || !pendingUpdates.size) return
    const kept = existingFindings(output).filter(finding => !pendingUpdates.has(finding.file))
    writeReport(output, {
      ...report, generatedAt: new Date().toISOString(), findings: [...kept, ...[...pendingUpdates.values()].flat()],
    })
    pendingUpdates.clear()
  }

  function update(file: string, findings: Finding[]): void {
    if (!output) return
    pendingUpdates.set(file, findings)
    clearTimeout(timer)
    timer = setTimeout(() => {
      try { flush() } catch (error) { log.error(`[explicit-imports] ${String(error)}`) }
    }, 150)
    timer.unref()
  }

  function forget(file: string): void {
    warned.delete(file)
    buildWarnings.delete(file)
    if (output && (pendingUpdates.has(file) || existingFindings(output).some(finding => finding.file === file))) update(file, [])
  }

  function ensureRegistry(): Registry {
    if (registry) return registry
    const loaded = loadRegistry(project)
    assertRegistryReady(project, loaded)
    registry = loaded
    return loaded
  }

  function finish(): void {
    flush()
    if (report?.source !== 'build' || summarized) return
    summarized = true
    const counts = countFindings([...buildWarnings.values()].flat())
    if (counts.total) {
      log.warn(`[explicit-imports] ${counts.total} finding(s) (${counts.imports} imports, ${counts.components} components, ${counts.directives} directives).`)
    }
  }

  return {
    name: 'vite-vue-explicit-imports',
    enforce: 'pre',
    configResolved(config) {
      const root = resolve(config.root, options.root ?? '.')
      project = new Project({ ...options, root, alias: { ...normalizeViteAliases(config.resolve.alias, config.root), ...options.alias } })
      registry = undefined
      log = config.logger
      output = options.report === false ? undefined : reportPath(root, typeof options.report === 'string' ? options.report : undefined)
      report = {
        version: 1, generatedAt: new Date().toISOString(), source: config.command === 'build' ? 'build' : 'dev',
        modes: project.modes,
      }
      pendingUpdates.clear()
      summarized = false
      warned.clear()
      buildWarnings.clear()
    },
    configureServer(server) {
      for (const path of [options.unimportItems, options.importsDts, options.componentsDts]) {
        if (path !== undefined) server.watcher.add(resolve(project.root, path))
      }
      const invalidate = (path: string) => {
        if (!isRegistryFile(project, resolve(path))) return
        registry = undefined
        server.moduleGraph.invalidateAll()
      }
      server.watcher.on('add', invalidate).on('change', invalidate).on('unlink', path => {
        invalidate(path)
        forget(resolve(path))
      })
      server.httpServer?.once('close', flush)
    },
    watchChange(id, { event }) {
      const file = resolve(id)
      if (isRegistryFile(project, file)) registry = undefined
      if (event === 'delete') forget(file)
    },
    buildStart() {
      registry = undefined
      summarized = false
    },
    transform(_code, id) {
      if (!project || id.includes('?') || !isAbsolute(id) || !project.includes(id)) return
      if (Object.values(project.modes).every(mode => mode === 'off')) return
      const file = resolve(id)
      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        forget(file)
        return
      }
      let loaded: Registry
      try {
        loaded = ensureRegistry()
      } catch (error) {
        this.error(error instanceof Error ? error : String(error))
      }
      if (report.source === 'build') {
        for (const path of Object.values(loaded.sources)) this.addWatchFile(path)
      }
      const { findings } = analyzeFile(file, source, project, loaded)
      update(file, findings)
      const warnings = findings.filter(finding => project.modes[finding.category] === 'warn')
      if (report.source === 'build') buildWarnings.set(file, warnings)
      const previous = warned.get(file)
      const current = new Set<string>()
      const locate = (finding: Finding) => `${formatFileLine(finding, project.root)} [${finding.category}] ${finding.name}. ${finding.suggestion}${finding.reason ? ` (${finding.reason})` : ''}`
      for (const finding of warnings) {
        const message = locate(finding)
        if (!previous?.has(message) && !current.has(message)) log.warn(`[explicit-imports] ${message}`)
        current.add(message)
      }
      warned.set(file, current)
      const strict = findings.filter(finding => project.modes[finding.category] === 'strict')
      if (strict.length) {
        flush()
        const first = strict[0]
        this.error({
          id: file, loc: { file, line: first.line, column: first.column - 1 },
          message: `${strict.map(locate).join('\n')}\nRun vite-vue-explicit-imports migrate ${JSON.stringify(formatFileLine(first, project.root).replace(/:\d+:\d+$/, ''))} and review any manual findings.`,
        })
      }
    },
    buildEnd: finish,
    closeBundle: finish,
  }
}

export default explicitImports
