import MagicString from 'magic-string'
import { formatImport, namedSpecifier } from './analyze'
import type { Analysis, ImportRequest, ScriptTarget } from './analyze'

interface Span { start: number; end: number }

function indentation(source: string, offset: number): string | undefined {
  const start = source.lastIndexOf('\n', offset - 1) + 1
  const prefix = source.slice(start, offset)
  return /^[\t ]*$/.test(prefix) ? prefix : undefined
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '')
}

function appendEntries(
  edit: MagicString, source: string, entries: Span[], open: number, close: number,
  additions: string[], newline: string,
): void {
  const last = entries.at(-1)
  const closingIndent = indentation(source, close)
  if (!last && !source.slice(open + 1, close).trim() && closingIndent === undefined) {
    const spacing = source.slice(open + 1, close) || ' '
    const contents = spacing + additions.join(', ') + spacing
    if (open + 1 === close) edit.appendLeft(close, contents)
    else edit.update(open + 1, close, contents)
    return
  }
  const trailing = last && withoutComments(source.slice(last.end, close)).includes(',')
  if (closingIndent !== undefined && source.slice(open, close).includes('\n')) {
    if (last && !trailing) edit.appendLeft(last.end, ',')
    const indent = (entries[0] && indentation(source, entries[0].start)) ?? closingIndent + '  '
    const lines = additions.map((item, i) => indent + item + (trailing || i < additions.length - 1 ? ',' : ''))
    edit.appendLeft(close - closingIndent.length, lines.join(newline) + newline)
  } else if (last) {
    edit.appendLeft(last.end, ', ' + additions.join(', '))
  } else {
    edit.appendLeft(close, ' ' + additions.join(', ') + ' ')
  }
}

function groupImports(requests: ImportRequest[]): ImportRequest[][] {
  const groups = new Map<string, ImportRequest[]>()
  for (const request of requests) {
    if (request.exportName === '*' || request.exportName === 'default') {
      groups.set(request.local, [request])
      continue
    }
    const key = JSON.stringify([request.from, request.type])
    const group = groups.get(key)
    if (group) group.push(request)
    else groups.set(key, [request])
  }
  return [...groups.values()]
}

function renderGroup(group: ImportRequest[], quote?: string): string {
  const first = formatImport(group[0], quote)
  if (group.length === 1) return first
  return first.replace('{ ' + namedSpecifier(group[0]) + ' }', () => '{ ' + group.map(namedSpecifier).join(', ') + ' }')
}

function patchScript(edit: MagicString, source: string, target: ScriptTarget, newline: string): void {
  const { start, end, program, requests, registration } = target
  const absolute = (span: Span): Span => ({ start: start + span.start, end: start + span.end })
  const imports = program.body.filter(statement => statement.type === 'ImportDeclaration')
  const namedImports = imports.flatMap(node => {
    if (node.attributes.length) return []
    const specs = node.specifiers.filter(spec => spec.type === 'ImportSpecifier').map(absolute)
    const first = specs[0]
    const opening = start + node.start
    if (!first) {
      if (node.specifiers.some(spec => spec.type === 'ImportNamespaceSpecifier')) return []
      const prefix = source.slice(opening, start + node.source.start)
      const masked = prefix.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, comment => ' '.repeat(comment.length))
      const empty = /\{\s*\}(?=\s*from\s*$)/.exec(masked)
      if (!empty) return []
      const open = opening + empty.index
      return [{ node, specs, open, close: open + empty[0].length - 1 }]
    }
    const last = specs.at(-1)!
    const tail = source.slice(last.end, start + node.source.start)
    const closing = /^(?:\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|[\s,])*\}/.exec(tail)
    if (!closing) return []
    return [{ node, specs, open: opening, close: last.end + closing[0].length - 1 }]
  })
  const named = new Map<typeof namedImports[number], string[]>()
  const remaining: ImportRequest[] = []
  for (const request of requests) {
    const existing = request.exportName !== 'default' && request.exportName !== '*' && namedImports.find(({ node }) =>
      node.source.value === request.from && (node.importKind === 'type') === request.type)
    if (!existing) remaining.push(request)
    else {
      const additions = named.get(existing) ?? []
      additions.push(namedSpecifier(request))
      named.set(existing, additions)
    }
  }
  for (const [{ specs, open, close }, additions] of named) {
    appendEntries(edit, source, specs, open, close, additions, newline)
  }

  if (remaining.length) {
    const last = imports.at(-1)
    const directives = program.body.filter(node => 'directive' in node && typeof node.directive === 'string')
    const preceding = last ?? directives.at(-1) ?? program.hashbang
    const first = program.body[0]
    const indent = (last ?? first) ? indentation(source, start + (last ?? first).start) ?? '' : ''
    const quote = last && source[start + last.source.start] === '"' ? '"' : "'"
    const semicolon = last && source[start + last.end - 1] === ';' ? ';' : ''
    const lines = groupImports(remaining).map(group => indent + renderGroup(group, quote) + semicolon).join(newline)
    if (preceding) {
      const position = start + preceding.end
      const gap = source.slice(position, end)
      const lineEnd = /^[\t ]*(?:\/\*[^\r\n]*?\*\/[\t ]*)*(?:\/\/[^\r\n]*)?\r?\n/.exec(gap)
      if (lineEnd) edit.appendLeft(position + lineEnd[0].length, lines + newline)
      else edit.appendLeft(position, newline + lines + newline)
    } else {
      const leading = /^(?:\uFEFF)?(?:[\t ]*\r?\n)*/.exec(source.slice(start, end))![0]
      const position = start + leading.length
      const prefix = start > 0 && !leading.endsWith('\n') ? newline : ''
      edit.appendLeft(position, prefix + lines + newline)
    }
  }

  if (registration?.names.length) {
    const object = registration.components ?? registration.options
    const additions = registration.components ? registration.names : ['components: { ' + registration.names.join(', ') + ' }']
    appendEntries(edit, source, object.properties.map(absolute), start + object.start, start + object.end - 1, additions, newline)
  }
}

export function applyFixes(analysis: Analysis): string {
  const { source } = analysis
  const edit = new MagicString(source)
  const newline = /\r?\n/.exec(source)?.[0] ?? '\n'
  for (const target of analysis.scripts) patchScript(edit, source, target, newline)
  if (analysis.createSetup?.requests.length) {
    const { lang, requests } = analysis.createSetup
    const opening = lang === 'ts' ? '<script setup lang="ts">' : '<script setup>'
    const block = [opening, ...groupImports(requests).map(group => renderGroup(group)), '</script>', '', ''].join(newline)
    edit.appendLeft(source.startsWith('\uFEFF') ? 1 : 0, block)
  }
  return edit.toString()
}
