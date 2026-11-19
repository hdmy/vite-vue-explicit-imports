import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'pathe'
import type { Category, Finding, Report } from './types'

export function reportPath(rootDir: string, customPath?: string): string {
  return resolve(rootDir, customPath ?? '.explicit-imports-report.json')
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => compare(a.file, b.file) || a.line - b.line || a.column - b.column
    || compare(a.category, b.category) || compare(a.name, b.name))
}

export function writeReport(file: string, report: Report): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...report, findings: sortFindings(report.findings) }, null, 2) + '\n')
}

export function mergeReport(report: Report, file: string, findings: readonly Finding[]): Report {
  return {
    ...report, generatedAt: new Date().toISOString(),
    findings: sortFindings([...report.findings.filter(finding => finding.file !== file), ...findings]),
  }
}

export function formatFileLine(finding: Finding, root?: string): string {
  return `${root ? relative(root, finding.file) : finding.file}:${finding.line}:${finding.column}`
}

export interface FindingCounts extends Record<Category, number> {
  total: number
}

export function countFindings(findings: readonly Finding[]): FindingCounts {
  const counts = { total: findings.length, imports: 0, components: 0, directives: 0 }
  for (const finding of findings) counts[finding.category]++
  return counts
}

export function summarizeByDirectory(findings: readonly Finding[], root = process.cwd()): Record<string, FindingCounts> {
  const groups = new Map<string, Finding[]>()
  for (const finding of findings) {
    const segments = relative(root, finding.file).split('/')
    segments.pop()
    const directory = segments.slice(0, segments[0] === 'src' ? 2 : 1).join('/') || '.'
    const group = groups.get(directory)
    if (group) group.push(finding)
    else groups.set(directory, [finding])
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => compare(a, b))
    .map(([directory, group]) => [directory, countFindings(group)]))
}
