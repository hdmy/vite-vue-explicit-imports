export const CATEGORIES = ['imports', 'components', 'directives'] as const
export type Category = (typeof CATEGORIES)[number]
export type Mode = 'off' | 'warn' | 'strict'
export type ModeOption = Mode | Partial<Record<Category, Mode>>
export type FindingKind = 'import' | 'type' | 'component' | 'directive'

export interface Finding {
  file: string
  line: number
  column: number
  category: Category
  kind: FindingKind
  name: string
  suggestion: string
  fixable: boolean
  reason?: string
}

export interface Report {
  version: 1
  generatedAt: string
  source: 'check' | 'dev' | 'build'
  modes: Record<Category, Mode>
  findings: Finding[]
}

export interface ExplicitImportsOptions {
  mode?: ModeOption
  root?: string
  srcDirs?: string[]
  exclude?: string[]
  alias?: Record<string, string>
  unimportItems?: string
  importsDts?: string
  componentsDts?: string
  packageSpecifiers?: Record<string, string>
  ignoreImports?: string[]
  ignoreComponents?: string[]
  ignoreDirectives?: string[]
  report?: boolean | string
}
