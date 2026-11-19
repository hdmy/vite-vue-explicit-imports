import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, compileTemplate, invalidateTypeCache, parse, registerTS } from '@vue/compiler-sfc'
import type { SFCDescriptor } from '@vue/compiler-sfc'
import { parseSync } from 'oxc-parser'
import type { Node, ObjectExpression, Program } from 'oxc-parser'
import { isReferenceIdentifier, parseAndWalk, ScopeTracker, ScopeTrackerImport, walk } from 'oxc-walker'
import { join, resolve } from 'pathe'
import { isFile, Project, SOURCE_EXTENSIONS } from './project'
import { kebabCase, pascalCase, resolverStylePackage, staticName } from './registry'
import type { ImportEntry, Registry } from './registry'
import type { Category, Finding } from './types'

const UNRESOLVED_METADATA = 'Vue script metadata or externally imported prop types could not be resolved. Verify this template usage manually.'
const MACROS = new Set([
  'defineProps', 'defineEmits', 'defineExpose', 'defineOptions', 'defineSlots', 'defineModel', 'withDefaults',
])

export interface ImportRequest {
  from: string
  exportName: string
  local: string
  type: boolean
}

export interface ScriptTarget {
  start: number
  end: number
  program: Program
  requests: ImportRequest[]
  registration?: { options: ObjectExpression; components?: ObjectExpression; names: string[] }
}

export interface Analysis {
  file: string
  source: string
  findings: Finding[]
  scripts: ScriptTarget[]
  createSetup?: { lang: 'ts' | 'js'; requests: ImportRequest[] }
}

interface ParsedScript {
  target: ScriptTarget
  scope: ScopeTracker
  bindings: Set<string>
}

function parseScript(content: string, filename: string, start: number): ParsedScript | undefined {
  const scope = new ScopeTracker({ preserveExitedScopes: true })
  const names = new Set<string>()
  const result = parseAndWalk(content, filename, {
    parseSync,
    scopeTracker: scope,
    enter(node) {
      if (node.type === 'Identifier') names.add(node.name)
    },
  })
  if (result.errors.length) return
  const bindings = new Set([...names].filter(name => scope.isDeclared(name)))
  scope.freeze()
  return { target: { start, end: start + content.length, program: result.program, requests: [] }, scope, bindings }
}

function optionsObject(program: Program): ObjectExpression | undefined {
  const declaration = program.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration
  const unwrap = (node: Node | undefined): Node | undefined => {
    while (node?.type === 'TSAsExpression' || node?.type === 'TSSatisfiesExpression'
      || node?.type === 'ParenthesizedExpression') node = node.expression
    return node
  }
  let expression = unwrap(declaration)
  if (expression?.type === 'CallExpression'
    && expression.callee.type === 'Identifier' && expression.callee.name === 'defineComponent') {
    expression = unwrap(expression.arguments[0])
  }
  if (expression?.type === 'ObjectExpression') return expression
}

function optionRegistry(options: ObjectExpression | undefined, name: string) {
  const properties = options?.properties.filter(prop => prop.type === 'Property' && staticName(prop.key) === name
    && (!prop.computed || prop.key.type === 'Literal'))
  const property = properties?.at(-1)
  const object = property?.type === 'Property' && property.value.type === 'ObjectExpression' ? property.value : undefined
  const names = new Set(object?.properties.flatMap(prop => {
    const key = prop.type === 'Property' && (!prop.computed || prop.key.type === 'Literal') ? staticName(prop.key) : undefined
    return key ? [kebabCase(pascalCase(key))] : []
  }))
  return { object, names, writable: !!options
    && options.properties.every(prop => prop.type === 'Property' && (!prop.computed || prop.key.type === 'Literal'))
    && (!property || !!object)
    && (object?.properties.every(prop =>
      prop.type === 'Property' && prop.kind === 'init' && (!prop.computed || prop.key.type === 'Literal')) ?? true) }
}

function setupProps(program: Program): Set<string> {
  const names = new Set<string>()
  const add = (name: string | undefined) => { if (name) names.add(name) }
  const types = new Map<string, Node>()
  for (const statement of program.body) {
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (node?.type === 'TSInterfaceDeclaration' || node?.type === 'TSTypeAliasDeclaration') types.set(node.id.name, node)
  }
  const visited = new Set<Node>()
  const collect = (node: Node | null | undefined): void => {
    if (!node || visited.has(node)) return
    visited.add(node)
    switch (node.type) {
      case 'ObjectExpression':
        for (const prop of node.properties) if (prop.type === 'Property' && !prop.computed) add(staticName(prop.key))
        break
      case 'ArrayExpression':
        for (const item of node.elements) if (item?.type === 'Literal') add(staticName(item))
        break
      case 'TSInterfaceDeclaration':
        collect(node.body)
        for (const parent of node.extends) if (parent.expression.type === 'Identifier') collect(types.get(parent.expression.name))
        break
      case 'TSInterfaceBody':
      case 'TSTypeLiteral':
        for (const prop of node.type === 'TSTypeLiteral' ? node.members : node.body) {
          if ((prop.type === 'TSPropertySignature' || prop.type === 'TSMethodSignature') && !prop.computed) add(staticName(prop.key))
        }
        break
      case 'TSTypeAliasDeclaration':
        collect(node.typeAnnotation)
        break
      case 'TSTypeReference':
        if (node.typeName.type === 'Identifier') collect(types.get(node.typeName.name))
        break
      case 'TSIntersectionType':
      case 'TSUnionType':
        for (const part of node.types) collect(part)
        break
    }
  }
  const macro = (node: Node | null | undefined): void => {
    if (node?.type !== 'CallExpression' || node.callee.type !== 'Identifier') return
    if (node.callee.name === 'withDefaults') {
      macro(node.arguments[0])
      collect(node.arguments[1])
    } else if (node.callee.name === 'defineProps') {
      collect(node.typeArguments?.params[0])
      collect(node.arguments[0])
    }
  }
  for (const statement of program.body) {
    if (statement.type === 'ExpressionStatement') macro(statement.expression)
    if (statement.type === 'VariableDeclaration') for (const declaration of statement.declarations) macro(declaration.init)
  }
  return names
}

let registeredTypeScript = false
const attemptedTypeScript = new WeakSet<Project>()

function registerProjectTypeScript(project: Project): void {
  if (registeredTypeScript || attemptedTypeScript.has(project)) return
  attemptedTypeScript.add(project)
  for (const from of [join(project.root, 'package.json'), import.meta.url]) {
    try {
      const compiler = createRequire(from)('typescript')
      registerTS(() => compiler)
      registeredTypeScript = true
      return
    } catch {
      // Relative type imports still work through the filesystem adapter.
    }
  }
}

function scriptMetadata(descriptor: SFCDescriptor, project: Project, normal?: ParsedScript, setup?: ParsedScript) {
  let metadata: NonNullable<NonNullable<Parameters<typeof compileTemplate>[0]['compilerOptions']>['bindingMetadata']> = {}
  let unresolvedMetadata = false
  const dependencies = new Set<string>()
  try {
    const declaration = normal?.target.program.body.find(node => node.type === 'ExportDefaultDeclaration')?.declaration
    const object = !setup && normal && optionsObject(normal.target.program)
    // Vue reads Options API metadata from a bare object. Unwrap defineComponent for this pass.
    const input = descriptor.script && declaration && object && declaration !== object
      ? { ...descriptor, script: { ...descriptor.script, content:
        descriptor.script.content.slice(0, declaration.start) + descriptor.script.content.slice(object.start, object.end)
        + descriptor.script.content.slice(declaration.end) } }
      : descriptor
    if (input.script || input.scriptSetup) {
      if (input.scriptSetup) registerProjectTypeScript(project)
      const compiled = compileScript(input, {
        id: 'explicit-imports',
        fs: {
          fileExists: isFile,
          readFile(file) {
            if (!isFile(file)) return
            dependencies.add(file)
            return readFileSync(file, 'utf8')
          },
          realpath: realpathSync,
        },
      })
      metadata = compiled.bindings ?? {}
      for (const file of compiled.deps ?? []) dependencies.add(file)
    }
  } catch {
    unresolvedMetadata = true
    if (setup) for (const name of setupProps(setup.target.program)) metadata[name] = 'props' as typeof metadata[string]
  } finally {
    // The compiler caches imported scopes and tsconfigs across analyses, including dev transforms.
    for (const file of dependencies) invalidateTypeCache(file)
  }
  if (setup) {
    for (const script of [normal, setup]) {
      for (const name of script?.bindings ?? []) {
        if (!Object.hasOwn(metadata, name)) metadata[name] = 'setup-const' as typeof metadata[string]
      }
    }
  }
  return { metadata, unresolvedMetadata }
}

export function formatImport(request: ImportRequest, quote = "'"): string {
  const { from, exportName, local, type } = request
  const source = from.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`).replaceAll('\r', '\\r').replaceAll('\n', '\\n')
  const specification = exportName === 'default' ? local
    : exportName === '*' ? `* as ${local}` : `{ ${namedSpecifier(request)} }`
  return `import ${type ? 'type ' : ''}${specification} from ${quote}${source}${quote}`
}

export function namedSpecifier({ exportName, local }: ImportRequest): string {
  return exportName === local ? local : `${exportName} as ${local}`
}

export function analyzeFile(file: string, source: string, project: Project, registry: Registry): Analysis {
  file = resolve(project.root, file)
  const analysis: Analysis = { file, source, findings: [], scripts: [] }
  if (!SOURCE_EXTENSIONS.test(file)) return analysis
  const isVue = file.endsWith('.vue')
  const sfc = isVue ? parse(source, { filename: file, ignoreEmpty: false }) : undefined
  if (sfc?.errors.length) return analysis
  const descriptor = sfc?.descriptor

  const selfClosing = (block: SFCDescriptor['script']) => !!block
    && block.loc.start.offset === block.loc.end.offset
    && source.slice(block.loc.start.offset - 2, block.loc.start.offset) === '/>'
  const selfClosingSetup = selfClosing(descriptor?.scriptSetup ?? null)
  const parseBlock = (block: SFCDescriptor['script']) => block && !block.src && !selfClosing(block)
    && ['js', 'jsx', 'ts', 'tsx'].includes(block.lang ?? 'js')
    ? parseScript(block.content, `${file}.${block.lang ?? 'js'}`, block.loc.start.offset)
    : undefined
  const normal = descriptor ? parseBlock(descriptor.script) : parseScript(source, file, 0)
  const setup = descriptor ? parseBlock(descriptor.scriptSetup) : undefined
  const scripts = [normal, setup].filter(script => script !== undefined)
  analysis.scripts = scripts.map(script => script.target)

  const pending = new Map<string, {
    entry: ImportEntry; category: Category; offset: number; type: boolean
    target?: ScriptTarget; reason?: string; register?: string; reuse?: boolean
  }>()
  const add = (
    entry: ImportEntry, category: Category, offset: number, type: boolean,
    target?: ScriptTarget, reason?: string, register?: string, reuse?: boolean,
  ) => {
    if (project.modes[category] === 'off' || project.sameFile(entry.filePath, file)) return
    const unverified = reason === UNRESOLVED_METADATA
    const pkg = !type && resolverStylePackage(entry)
    if (!reason && pkg && !project.options.externalStyles?.includes(pkg)) {
      reason = `Explicit imports from '${pkg}' bypass resolver-injected styles. Confirm global theme CSS or a style plugin in every entry point, then pass --external-styles ${pkg} (or externalStyles: ['${pkg}']).`
    }
    const key = JSON.stringify([category, entry.local, unverified, category === 'components' && !!reason && !register])
    const current = pending.get(key)
    if (!current || (current.type && !type)) {
      pending.set(key, {
        entry, category, offset: current?.offset ?? offset, type,
        target: current?.target === normal?.target && !current?.reason ? current?.target ?? target : target,
        reason, register, reuse,
      })
    }
  }

  for (const script of scripts) {
    const ancestors: Node[] = []
    walk(script.target.program, {
      scopeTracker: script.scope,
      enter(node, parent) {
        const grandparent = ancestors.at(-2)
        ancestors.push(node)
        // Skipping whole subtrees would change ScopeTracker's frozen scope numbering.
        if ((node.type !== 'Identifier' && node.type !== 'JSXIdentifier') || !parent) return
        const entry = registry.imports.get(node.name)
        if (!entry || (script === setup && MACROS.has(node.name))) return
        if (ancestors.some(ancestor => ancestor.type === 'ExportNamedDeclaration' && ancestor.source)) return

        let queryTarget: Node = node
        let level = ancestors.length - 2
        while (true) {
          const ancestor = ancestors[level]
          if (ancestor?.type !== 'TSQualifiedName' || ancestor.left !== queryTarget) break
          queryTarget = ancestor
          level--
        }
        const queryParent = ancestors[level]
        if (queryParent?.type === 'TSImportType' && queryParent.qualifier === queryTarget) return
        const query = queryParent?.type === 'TSTypeQuery' && queryParent.exprName === queryTarget
        const typeExport = parent.type === 'ExportSpecifier' && (parent.exportKind === 'type'
          || (grandparent?.type === 'ExportNamedDeclaration' && grandparent.exportKind === 'type'))
        const typeOnly = query || typeExport || (isReferenceIdentifier(node, parent, { mode: 'type' })
          && !isReferenceIdentifier(node, parent, { mode: 'value' }))
        if (!isReferenceIdentifier(node, parent, { mode: typeOnly && !query && !typeExport ? 'type' : 'all' })
          && !query && !typeExport) return
        if (query && parent.type === 'TSQualifiedName' && parent.left !== node) return
        if (typeExport && parent.type === 'ExportSpecifier' && parent.local !== node) return
        const mode = typeOnly && !query ? 'type' : 'value'
        const declared = (block: ParsedScript | undefined) => block?.scope.isDeclared(node.name, { mode })
          || (query && block?.scope.getDeclaration(node.name, { mode: 'type' }) instanceof ScopeTrackerImport)
        if (declared(script) || (script === setup && declared(normal))) return

        const reason = (!typeOnly || query) && entry.type ? 'The registry exposes this name only as a type.'
          : !typeOnly && /\.(?:cts|cjs)$/.test(file) ? 'A CommonJS file requires a manual runtime import.'
          : undefined
        add(entry, 'imports', script.target.start + node.start, typeOnly, script.target, reason)
      },
      leave() { ancestors.pop() },
    })
  }

  const template = descriptor?.template
  if (descriptor && template && !template.src && (!template.lang || template.lang === 'html')) {
    const { metadata, unresolvedMetadata } = scriptMetadata(descriptor, project, normal, setup)
    const compiled = compileTemplate({
      filename: file, id: 'explicit-imports', source: template.content,
      compilerOptions: { prefixIdentifiers: true, bindingMetadata: metadata },
    })
    if (compiled.ast && !compiled.errors.length) {
      const components = new Set(compiled.ast.components)
      const directives = new Set(compiled.ast.directives)
      const bindings = new Set(scripts.flatMap(script => [...script.bindings]))
      const hasScript = !!(descriptor.script || descriptor.scriptSetup)
      const options = !descriptor.scriptSetup && normal ? optionsObject(normal.target.program) : undefined
      const registeredComponents = optionRegistry(options, 'components')
      const registeredDirectives = optionRegistry(options, 'directives')
      const unavailable = selfClosingSetup ? 'Expand the self-closing <script setup /> before adding imports.'
        : unresolvedMetadata ? UNRESOLVED_METADATA
        : hasScript && !setup ? 'This template requires a manual Options API binding.' : undefined
      const unavailableComponent = selfClosingSetup ? unavailable
        : unresolvedMetadata ? UNRESOLVED_METADATA
        : 'Could not safely edit the Options API components registry.'
      const templateOffset = template.loc.start.offset
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const child of value) visit(child)
          return
        }
        if (!value || typeof value !== 'object' || !('type' in value)) return
        const node = value as {
          type: number; tag?: string; name?: string; content?: string; isStatic?: boolean
          loc?: { start: { offset: number } }
        }
        const offset = templateOffset + (node.loc?.start.offset ?? 0)
        if (node.type === 4 && !node.isStatic && typeof node.content === 'string') {
          const match = /^_ctx\.([$\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)(?![$\u200c\u200d\p{ID_Continue}])/u.exec(node.content)
          const name = match?.[1]
          const entry = name && registry.imports.get(name)
          const component = name && !entry && registry.components.get(name)
          if (entry && !bindings.has(entry.local) && !Object.hasOwn(metadata ?? {}, entry.local)) {
            add(entry, 'imports', offset, false, setup?.target,
              unavailable ?? (entry.type ? 'The registry exposes this name only as a type.' : undefined))
          }
          if (component && name === component.pascalName
            && !bindings.has(component.local) && !Object.hasOwn(metadata, component.local)) {
            add(component, 'components', offset, false, setup?.target, unavailable)
          }
        }
        if (node.type === 1 && node.tag && (components.has(node.tag) || components.has(`${node.tag}__self`))) {
          const entry = registry.components.get(node.tag) ?? registry.components.get(pascalCase(node.tag))
          if (entry && !(setup && bindings.has(entry.local)) && !registeredComponents.names.has(entry.kebabName)) {
            const reuse = !!normal?.target.program.body.some(statement =>
              statement.type === 'ImportDeclaration' && statement.importKind !== 'type'
              && statement.specifiers.some(spec => spec.local.name === entry.local
                && (spec.type !== 'ImportSpecifier' || spec.importKind !== 'type')))
            const canRegister = normal && options && registeredComponents.writable
            if (canRegister) {
              normal.target.registration ??= { options, components: registeredComponents.object, names: [] }
            }
            add(entry, 'components', offset + 1, false, setup?.target ?? (canRegister ? normal.target : undefined),
              unresolvedMetadata || (hasScript && !setup && !canRegister) ? unavailableComponent : undefined,
              canRegister ? entry.local : undefined, reuse)
          }
        }
        if (node.type === 7 && node.name && directives.has(node.name)) {
          const name = kebabCase(pascalCase(node.name))
          const entry = registry.directives.get(name)
          if (entry && !(setup && bindings.has(entry.local)) && !registeredDirectives.names.has(name)) {
            add(entry, 'directives', offset, false, setup?.target, unavailable)
          }
        }
        for (const [key, child] of Object.entries(value)) {
          if (key !== 'ast' && key !== 'codegenNode' && key !== 'loc' && key !== 'hoists') visit(child)
        }
      }
      visit(compiled.ast)
    }
  }

  const claimed = new Map<string, ImportRequest>()
  const sharedRuntime = new Set([...pending.values()].filter(usage => !usage.type && !usage.reason)
    .map(({ entry }) => JSON.stringify([entry.local, entry.filePath ?? entry.from, entry.exportName])))
  for (const { entry, category, offset, type, target, reason, register, reuse } of pending.values()) {
    const request = {
      from: entry.filePath ? project.aliasFor(entry.filePath, entry.filePath.endsWith('.vue'), file)! : entry.from,
      local: entry.local, exportName: entry.exportName,
      type: type && !sharedRuntime.has(JSON.stringify([entry.local, entry.filePath ?? entry.from, entry.exportName])),
    }
    const previous = claimed.get(request.local)
    const collision = previous && (previous.from !== request.from || previous.exportName !== request.exportName || previous.type !== request.type)
    const existing = !reuse && scripts.some(script => script.scope.isDeclared(request.local, { mode: 'all' }))
    const manual = reason ?? (existing ? 'An existing top-level binding uses this import name.' : undefined) ?? (collision ? 'Another finding requires a different import with the same local name.' : undefined)
    if (!manual) {
      if (!previous && !reuse) {
        claimed.set(request.local, request)
        if (target) target.requests.push(request)
        else {
          analysis.createSetup ??= { lang: project.isTypeScript ? 'ts' : 'js', requests: [] }
          analysis.createSetup.requests.push(request)
        }
      }
      if (register) target?.registration?.names.push(register)
    }
    const lines = source.slice(0, offset).split(/\r\n|\n|\r/)
    analysis.findings.push({
      file, line: lines.length, column: lines.at(-1)!.length + 1, category,
      kind: category === 'imports' ? type ? 'type' : 'import' : category === 'components' ? 'component' : 'directive',
      name: category === 'directives' ? (entry as ImportEntry & { name: string }).name : entry.local,
      suggestion: reuse && register ? `Register ${register} in components` : formatImport(request), fixable: !manual, ...(manual ? { reason: manual } : {}),
    })
  }
  return analysis
}
