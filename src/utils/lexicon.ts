import { lexiconFromLines } from './segment'
import { FREQ50K } from './freq50k'

export const LEXICON = lexiconFromLines(FREQ50K)
