import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'pathe'
import picomatch from 'picomatch'
import { globSync } from 'tinyglobby'
import { resolveModes } from './options'
import type { ExplicitImportsOptions } from './types'

export const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx|vue)$/
const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/
const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/dist/**', '**/.git/**', '**/*.d.{ts,mts,cts}',
  '**/*.config.*', '**/*.{test,spec}.*', '**/{test,tests,__tests__,e2e}/**',
]

interface TsConfig {
  extends?: string | string[]
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
  references?: { path: string }[]
}

function readConfig(file: string): TsConfig {
  const source = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g
  const uncommented = source.replace(tokens, token => token.startsWith('"') ? token : ' ')
  try {
    return JSON.parse(uncommented.replace(/"(?:\\[\s\S]|[^"\\])*"|,(?=\s*[}\]])/g, token => token === ',' ? '' : token))
  } catch (error) {
    throw new Error(`Invalid tsconfig JSONC in ${file}`, { cause: error })
  }
}

function inside(path: string): boolean {
  return path !== '..' && !path.startsWith('../') && !isAbsolute(path)
}

function configPath(path: string): string {
  if (existsSync(path) && statSync(path).isDirectory()) return join(path, 'tsconfig.json')
  if (!existsSync(path) && !path.endsWith('.json') && existsSync(`${path}.json`)) return `${path}.json`
  return path
}

export class Project {
  readonly root: string
  readonly srcDirs: string[]
  readonly modes: ReturnType<typeof resolveModes>
  readonly isTypeScript: boolean
  private readonly aliases = new Map<string, { path: string; wildcard: boolean }>()
  private readonly exclude: (path: string) => boolean

  constructor(readonly options: ExplicitImportsOptions = {}) {
    this.root = resolve(options.root ?? process.cwd())
    const src = join(this.root, 'src')
    this.srcDirs = options.srcDirs ?? (existsSync(src) && statSync(src).isDirectory() ? ['src'] : ['.'])
    this.modes = resolveModes(options.mode)
    this.exclude = picomatch([...DEFAULT_EXCLUDE, ...options.exclude ?? []], { dot: true })

    const visited = new Map<string, string | undefined>()
    const load = (filename: string): string | undefined => {
      const file = configPath(filename)
      if (visited.has(file) || !existsSync(file)) return visited.get(file)
      visited.set(file, undefined)
      const config = readConfig(file)
      const directory = dirname(file)
      let inheritedBase: string | undefined
      for (const parent of [config.extends ?? []].flat()) {
        if (parent.startsWith('.') || isAbsolute(parent)) inheritedBase = load(resolve(directory, parent)) ?? inheritedBase
      }
      const { baseUrl, paths } = config.compilerOptions ?? {}
      const base = baseUrl === undefined ? inheritedBase : resolve(directory, baseUrl)
      visited.set(file, base)
      for (const [key, targets] of Object.entries(paths ?? {})) {
        const target = targets[0]
        if (!target) continue
        if (key.endsWith('/*') && target.endsWith('/*')) {
          this.aliases.set(key.slice(0, -2), { path: resolve(base ?? directory, target.slice(0, -2)), wildcard: true })
        } else if (!key.includes('*') && !target.includes('*')) {
          this.aliases.set(key, { path: resolve(base ?? directory, target), wildcard: false })
        }
      }
      for (const reference of config.references ?? []) load(resolve(directory, reference.path))
      return base
    }
    for (const name of ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.web.json']) load(join(this.root, name))
    for (const [key, path] of Object.entries(options.alias ?? {})) {
      this.aliases.set(key.replace(/(?:\/\*)?\/+$/, '').replace(/\/\*$/, ''), { path: resolve(this.root, path.replace(/(?:\/\*)?\/+$/, '').replace(/\/\*$/, '')), wildcard: true })
    }
    this.isTypeScript = visited.size > 0 || this.sourceFiles().some(file => /\.(?:[cm]?ts|tsx)$/.test(file))
  }

  sourceFiles(): string[] {
    const files = this.srcDirs.flatMap(dir => globSync('**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs,vue}', {
      cwd: resolve(this.root, dir), expandDirectories: false, absolute: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
    }))
    return [...new Set(files)].filter(file => this.includes(file)).sort()
  }

  includes(file: string): boolean {
    const absolute = resolve(this.root, file)
    return SOURCE_EXTENSIONS.test(absolute) && !this.exclude(relative(this.root, absolute))
      && this.srcDirs.some(dir => inside(relative(resolve(this.root, dir), absolute)))
  }

  resolveLocal(from: string, directory: string): string | undefined {
    if (from.startsWith('.') || isAbsolute(from)) return resolve(directory, from)
    for (const [alias, entry] of [...this.aliases].sort(([a], [b]) => b.length - a.length)) {
      if (from === alias) return entry.path
      if (entry.wildcard && from.startsWith(`${alias}/`)) return resolve(entry.path, from.slice(alias.length + 1))
    }
  }

  aliasFor(absPath: string, keepExtension: boolean, importingFile?: string): string | undefined {
    const file = resolve(absPath)
    const clean = (specifier: string) => keepExtension
      ? specifier
      : specifier.replace(SCRIPT_EXTENSION, '').replace(/\/index$/, '')
    for (const [alias, entry] of [...this.aliases].reverse().sort(([, a], [, b]) => b.path.length - a.path.length)) {
      if (file === entry.path || (!entry.wildcard && this.sameFile(file, entry.path))) return alias
      const suffix = relative(entry.path, file)
      if (entry.wildcard && inside(suffix)) return clean(`${alias}/${suffix}`)
    }
    if (importingFile) {
      const path = clean(relative(dirname(importingFile), file))
      return path === '..' || path.startsWith('../') ? path : path ? `./${path}` : './'
    }
  }

  sameFile(a: string | undefined, b: string): boolean {
    if (!a) return false
    const first = resolve(a)
    const second = resolve(b)
    if (first === second) return true
    // Two concrete files can be different even when their extensionless paths match.
    if ([first, second].every(file => existsSync(file) && statSync(file).isFile())) return false
    const normalize = (file: string) => file.replace(SCRIPT_EXTENSION, '').replace(/\/index$/, '')
    return normalize(first) === normalize(second)
  }
}
