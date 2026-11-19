import { existsSync, readFileSync } from 'node:fs'
import { parseSync } from 'oxc-parser'
import type { Node } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { dirname, resolve } from 'pathe'
import { globSync } from 'tinyglobby'
import { Project } from './project'

export interface ImportEntry {
  local: string
  exportName: string
  from: string
  filePath?: string
  type?: boolean
}

export interface ComponentEntry extends ImportEntry {
  pascalName: string
  kebabName: string
}

export interface DirectiveEntry extends ImportEntry {
  name: string
}

export interface Registry {
  imports: Map<string, ImportEntry>
  components: Map<string, ComponentEntry>
  directives: Map<string, DirectiveEntry>
}

export function kebabCase(name: string): string {
  return name.replace(/\B([A-Z])/g, '-$1').toLowerCase()
}

export function pascalCase(name: string): string {
  return name.replace(/(?:^|-)(\w)/g, (_, letter: string) => letter.toUpperCase())
}

export function staticName(node: Node): string | undefined {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
}

function importType(node: Node | null | undefined): { from: string; exportName: string } | undefined {
  if (!node) return
  if (node.type === 'TSTypeQuery') return importType(node.exprName)
  if (node.type === 'TSIndexedAccessType' && node.indexType.type === 'TSLiteralType') {
    const source = importType(node.objectType)
    const exportName = staticName(node.indexType.literal)
    if (source?.exportName === '*' && exportName) return { from: source.from, exportName }
  }
  if (node.type === 'TSImportType' && typeof node.source.value === 'string') {
    const exportName = node.qualifier ? staticName(node.qualifier) : '*'
    if (exportName) return { from: node.source.value, exportName }
  }
}

function discovery(root: string, explicit: string | undefined, basename: string): string | undefined {
  if (explicit !== undefined) return resolve(root, explicit)
  return [basename, `src/${basename}`, ...globSync(`src/*.${basename}`, { cwd: root }).sort()]
    .map(file => resolve(root, file)).find(existsSync)
}

interface DumpItem {
  name: string
  as?: string
  from: string
  type?: boolean
  disabled?: boolean
}

function readDump(file: string): DumpItem[] {
  const items: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(items)) throw new Error(`Expected an array in ${file}`)
  return items.map((item, index) => {
    if (!item || typeof item.name !== 'string' || !item.name
      || typeof item.from !== 'string' || !item.from
      || (item.as !== undefined && (typeof item.as !== 'string' || !item.as.trim()))
      || (['*', 'default'].includes(item.name) && !item.as)
      || (item.type !== undefined && typeof item.type !== 'boolean')
      || (item.disabled !== undefined && typeof item.disabled !== 'boolean')) {
      throw new Error(`Invalid unimport item at index ${index} in ${file}`)
    }
    return item
  })
}

export function loadRegistry(project: Project): Registry {
  const { root, options } = project
  const registry: Registry = { imports: new Map(), components: new Map(), directives: new Map() }
  const packages = { 'element-plus/es': 'element-plus', 'ant-design-vue/es': 'ant-design-vue', ...options.packageSpecifiers }
  const normalize = (file: string, local: string, from: string, exportName: string): ImportEntry => {
    const filePath = project.resolveLocal(from, dirname(file))
    if (filePath) return { from: project.aliasFor(filePath, filePath.endsWith('.vue')) ?? from, exportName, local, filePath }
    return { from: Object.hasOwn(packages, from) ? packages[from as keyof typeof packages] : from, exportName, local }
  }
  const addImport = (file: string, local: string, from: string, exportName: string, type = false) => {
    if (!options.ignoreImports?.includes(local) && (!type || registry.imports.get(local)?.type !== false)) {
      registry.imports.set(local, { ...normalize(file, local, from, exportName), type })
    }
  }
  const parse = (file: string) => {
    const result = parseSync(file, readFileSync(file, 'utf8'), { lang: 'dts' })
    if (result.errors.length) throw new Error(`Could not parse ${file}: ${result.errors[0].message}`)
    return result.program
  }

  const dump = options.unimportItems !== undefined
    ? resolve(root, options.unimportItems)
    : resolve(root, '.unimport-items.json')
  if (options.unimportItems !== undefined || existsSync(dump)) {
    for (const item of readDump(dump)) {
      if (!item.disabled) addImport(dump, item.as ?? item.name, item.from, item.name, item.type)
    }
  } else {
    const file = discovery(root, options.importsDts, 'auto-imports.d.ts')
    if (file) {
      walk(parse(file), {
        enter(node) {
          if (node.type === 'TSModuleDeclaration' && !node.global) this.skip()
          if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
            const ref = importType(node.id.typeAnnotation?.typeAnnotation)
            if (ref) addImport(file, node.id.name, ref.from, ref.exportName)
          }
          if (node.type === 'TSTypeAliasDeclaration') {
            const ref = importType(node.typeAnnotation)
            if (ref) addImport(file, node.id.name, ref.from, ref.exportName, true)
          }
          if (node.type === 'ExportNamedDeclaration' && node.source) {
            for (const spec of node.specifiers) {
              if (node.exportKind !== 'type' && spec.exportKind !== 'type') continue
              const local = staticName(spec.exported)
              const imported = staticName(spec.local)
              if (local && imported) addImport(file, local, node.source.value, imported, true)
            }
          }
        },
      })
    }
  }

  const file = discovery(root, options.componentsDts, 'components.d.ts')
  if (!file) return registry
  walk(parse(file), {
    enter(node) {
      if (node.type === 'TSModuleDeclaration' && !node.global
        && !['vue', '@vue/runtime-core'].includes(staticName(node.id) ?? '')) this.skip()
      if (node.type !== 'TSInterfaceDeclaration'
        || !['GlobalComponents', 'GlobalDirectives', 'ComponentCustomDirectives'].includes(node.id.name)) return
      for (const prop of node.body.body) {
        if (prop.type !== 'TSPropertySignature' || prop.computed) continue
        const key = staticName(prop.key)
        const ref = importType(prop.typeAnnotation?.typeAnnotation)
        if (!key || !ref) continue
        if (node.id.name !== 'GlobalComponents' || /^v[A-Z]/.test(key)) {
          const name = kebabCase(key.replace(/^v(?=[A-Z])/, '').replace(/^v-/, ''))
          const local = `v${pascalCase(name)}`
          if (options.ignoreDirectives?.some(ignore => ignore === name || ignore === local)) continue
          registry.directives.set(name, { ...normalize(file, local, ref.from, ref.exportName), name })
        } else {
          const pascalName = pascalCase(key)
          const kebabName = kebabCase(pascalName)
          if (options.ignoreComponents?.some(ignore => [key, pascalName, kebabName].includes(ignore))) continue
          const entry = { ...normalize(file, pascalName, ref.from, ref.exportName), pascalName, kebabName }
          registry.components.set(pascalName, entry)
          registry.components.set(kebabName, entry)
        }
      }
    },
  })
  return registry
}
