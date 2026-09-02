import type { SessionConfigControl } from '../agent'

/** Filters only presentation choices; the agent-owned control table is never mutated. */
export function projectVisibleModelChoices(
  controls: readonly SessionConfigControl[],
  hiddenModelAliases: readonly string[],
): readonly SessionConfigControl[] {
  if (hiddenModelAliases.length === 0) {
    return controls
  }
  const hidden = new Set(hiddenModelAliases)
  let changed = false
  const projected = controls.map((control) => {
    if (control.purpose !== 'model') {
      return control
    }
    const choices = control.choices.filter(
      (choice) => choice.value === control.current || !hidden.has(choice.value),
    )
    if (choices.length === control.choices.length) {
      return control
    }
    changed = true
    return { ...control, choices }
  })
  return changed ? projected : controls
}
