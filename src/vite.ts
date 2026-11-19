import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'pathe'
import type { Plugin, ResolvedConfig } from 'vite'
import { analyzeFile } from './analyze'
import { Project } from './project'
import { loadRegistry } from './registry'
import type { Registry } from './registry'
import { countFindings, formatFileLine, mergeReport, reportPath, writeReport } from './report'
import { normalizeViteAliases } from './run'
import type { ExplicitImportsOptions, Finding, Report } from './types'

export function explicitImports(options: ExplicitImportsOptions = {}): Plugin {
  let project: Project
  let registry: Registry
  let log: ResolvedConfig['logger']
  let report: Report
  let output: string | undefined
  let dirty = false
  let summarized = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const warned = new Map<string, Set<string>>()
  const buildWarnings = new Map<string, Finding[]>()

  function flush(): void {
    clearTimeout(timer)
    timer = undefined
    if (output && dirty) writeReport(output, report)
    dirty = false
  }

  function update(file: string, findings: Finding[]): void {
    if (!output) return
    report = mergeReport(report, file, findings)
    dirty = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      try { flush() } catch (error) { log.error(`[explicit-imports] ${String(error)}`) }
    }, 150)
    timer.unref()
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
      registry = loadRegistry(project)
      log = config.logger
      report = {
        version: 1, generatedAt: new Date().toISOString(), source: config.command === 'build' ? 'build' : 'dev',
        modes: project.modes, findings: [],
      }
      output = options.report === false ? undefined : reportPath(root, typeof options.report === 'string' ? options.report : undefined)
      dirty = !!output
      summarized = false
      warned.clear()
      buildWarnings.clear()
    },
    configureServer(server) {
      server.watcher.on('unlink', path => {
        const file = resolve(path)
        if (!project.includes(file)) return
        warned.delete(file)
        update(file, [])
      })
      server.httpServer?.once('close', flush)
    },
    buildStart() {
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
        warned.delete(file)
        buildWarnings.delete(file)
        update(file, [])
        return
      }
      const { findings } = analyzeFile(file, source, project, registry)
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
