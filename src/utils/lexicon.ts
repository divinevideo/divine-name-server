import { lexiconFromLines } from './segment'
import { FREQ50K } from './freq50k'

let lexicon: Map<string, number> | undefined

/** Parse the bundled frequency list only when an ambiguous name needs judging. */
export function getLexicon(): Map<string, number> {
  lexicon ??= lexiconFromLines(FREQ50K)
  return lexicon
}
