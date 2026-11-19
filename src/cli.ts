#!/usr/bin/env node
import { cac } from 'cac'
import { relative } from 'pathe'
import { countFindings, formatFileLine } from './report'
import { check, migrate, openSession } from './run'
import type { SessionOptions } from './run'
import { CATEGORIES } from './types'
import type { Category, Mode } from './types'

interface Flags {
  root?: string
  config?: string
  category?: string
  importsDts?: string
  componentsDts?: string
  unimportItems?: string
  ignoreImports?: string
  ignoreComponents?: string
  ignoreDirectives?: string
  exclude?: string
  report?: boolean | string
  json?: boolean
  dryRun?: boolean
}

const cli = cac('vite-vue-explicit-imports')
const split = (value?: string) => value?.split(',').map(item => item.trim()).filter(Boolean)
const print = (line: string) => process.stdout.write(line + '\n')

cli.option('--root <dir>', 'Project root')
  .option('--config <file>', 'Vite config file relative to root')
  .option('--category <list>', 'Comma-separated categories: imports, components, directives')
  .option('--imports-dts <file>', 'Auto-import declarations')
  .option('--components-dts <file>', 'Component and directive declarations')
  .option('--unimport-items <file>', 'Unimport registry dump')
  .option('--ignore-imports <list>', 'Comma-separated global import names')
  .option('--ignore-components <list>', 'Comma-separated component names')
  .option('--ignore-directives <list>', 'Comma-separated directive names')
  .option('--exclude <list>', 'Comma-separated glob exclusions')
  .option('--report <path>', 'Write the check report to this path')
  .option('--no-report', 'Disable the check report', { default: '' })
  .option('--json', 'Print machine-readable JSON')

function sessionOptions(paths: string[], flags: Flags): SessionOptions {
  const categories = split(flags.category)
  let mode: Partial<Record<Category, Mode>> | undefined
  if (categories) {
    if (!categories.length || categories.some(category => !CATEGORIES.includes(category as Category))) {
      throw new Error(`Invalid category list. Expected one or more of ${CATEGORIES.join(', ')}.`)
    }
    mode = Object.fromEntries(CATEGORIES.map(category => [category, categories.includes(category) ? 'warn' : 'off']))
  }
  return {
    root: flags.root, config: flags.config, mode, paths,
    importsDts: flags.importsDts, componentsDts: flags.componentsDts, unimportItems: flags.unimportItems,
    ignoreImports: split(flags.ignoreImports), ignoreComponents: split(flags.ignoreComponents),
    ignoreDirectives: split(flags.ignoreDirectives), exclude: split(flags.exclude), report: flags.report === '' ? undefined : flags.report,
  }
}

async function session(paths: string[], flags: Flags) {
  const result = await openSession(sessionOptions(paths, flags))
  if (result.configError) process.stderr.write(`Vite config aliases unavailable. Using project aliases. ${result.configError}\n`)
  return result
}

function describeCounts(counts: ReturnType<typeof countFindings>): string {
  return `${counts.total} total, ${CATEGORIES.map(category => `${counts[category]} ${category}`).join(', ')}`
}

cli.command('check [...paths]', 'Find usages that still rely on auto-imports')
  .action(async (paths: string[], flags: Flags) => {
    const opened = await session(paths, flags)
    const { report, reportFile, summary } = check(opened)
    if (flags.json) print(JSON.stringify({ ...report, reportFile, summary }, null, 2))
    else {
      for (const finding of report.findings) {
        print(`${formatFileLine(finding, opened.project.root)} [${finding.category}] ${finding.name}. ${finding.suggestion}${finding.reason ? ` (${finding.reason})` : ''}`)
      }
      print(`Findings — ${describeCounts(summary)}`)
      for (const [directory, counts] of Object.entries(summary.directories)) print(`  ${directory} — ${describeCounts(counts)}`)
      if (reportFile) print(`Report written to ${relative(opened.project.root, reportFile)}`)
    }
    process.exitCode = report.findings.length ? 1 : 0
  })

cli.command('migrate [...paths]', 'Insert explicit imports and report manual work')
  .option('--dry-run', 'Preview changes without writing files')
  .action(async (paths: string[], flags: Flags) => {
    const opened = await session(paths, flags)
    const result = migrate(opened, { dryRun: flags.dryRun })
    if (flags.json) print(JSON.stringify({ ...result, dryRun: !!flags.dryRun }, null, 2))
    else {
      for (const file of result.changed) print(`${flags.dryRun ? 'Would update' : 'Updated'} ${relative(opened.project.root, file)}`)
      for (const finding of result.manual) print(`${formatFileLine(finding, opened.project.root)} ${finding.name}. ${finding.reason} ${finding.suggestion}`)
      print(`${result.changed.length} file(s), ${result.fixed.length} ${flags.dryRun ? 'fixable' : 'fixed'}, ${result.manual.length} manual.`)
    }
  })

cli.help()

try {
  // CAC consumes the next positional argument after a bare boolean flag.
  const argv = [...process.argv]
  const optionsEnd = argv.indexOf('--')
  for (let index = 2; index < (optionsEnd === -1 ? argv.length : optionsEnd); index++) {
    if (['--json', '--dry-run'].includes(argv[index])) argv[index] += '=true'
  }
  cli.parse(argv, { run: false })
  if (cli.matchedCommand) await cli.runMatchedCommand()
  else if (!cli.options.help) {
    if (cli.args.length) throw new Error(`Unknown command "${cli.args[0]}". Use --help to list commands.`)
    cli.outputHelp()
  }
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 2
}
