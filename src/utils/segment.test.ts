// ABOUTME: Segmentation must still produce both readings when the name contains a digit.

import { describe, expect, it } from 'vitest'
import { lexiconFromLines, readingsFor } from './segment'

const lexicon = lexiconFromLines([
  'anal 100',
  'master 80',
  'hassan 50',
  'alvarez 50',
  'canal 40',
  'vine 30',
].join('\n'))

function exact(word: string): (span: string) => boolean {
  return (span) => span === word
}

describe('readingsFor', () => {
  it('returns a reading on each side of the blocked word', () => {
    const pair = readingsFor('analvine', lexicon, exact('anal'))
    expect(pair.withWord?.segments).toContain('anal')
    expect(pair.withoutWord?.segments ?? []).not.toContain('anal')
  })

  it('does not return null just because the name contains a digit', () => {
    const innocent = readingsFor('master2', lexicon, exact('anal'))
    expect(innocent.withoutWord).not.toBeNull()
    expect(innocent.withoutWord?.segments).toContain('2')

    const pair = readingsFor('analvine2', lexicon, exact('anal'))
    expect(pair.withWord).not.toBeNull()
    expect(pair.withWord?.segments).toContain('2')
    expect(pair.withWord?.segments).toContain('anal')
  })

  it('can place the blocked word across a separator that was stripped', () => {
    const pair = readingsFor('hassan-alvarez', lexicon, exact('anal'))
    expect(pair.withWord?.segments).toContain('anal')
  })
})
