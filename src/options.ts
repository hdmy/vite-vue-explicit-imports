import { CATEGORIES } from './types'
import type { Category, Mode, ModeOption } from './types'

export function resolveModes(option?: ModeOption): Record<Category, Mode> {
  const modes: Record<Category, Mode> = { imports: 'warn', components: 'warn', directives: 'warn' }
  if (option === undefined) return modes
  for (const category of CATEGORIES) {
    const mode = option && typeof option === 'object' && !Array.isArray(option)
      ? option[category] === undefined ? modes[category] : option[category]
      : option
    if (mode !== 'off' && mode !== 'warn' && mode !== 'strict') {
      throw new Error(`Invalid mode for "${category}": ${String(mode)}. Expected off, warn, or strict.`)
    }
    modes[category] = mode
  }
  return modes
}
