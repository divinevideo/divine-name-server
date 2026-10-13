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
  'quil 60',
  'zorbs 60',
  'zorb 20',
  'brop 60',
  'sbrop 5',
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

  it('keeps the word out of every segment of the reading without it', () => {
    const pair = readingsFor('quilzorbsbrop', lexicon, exact('zorb'))
    expect(pair.withWord?.segments).toContain('zorb')
    expect(pair.withoutWord).toBeNull()
  })

  it('still finds a reading that splits the word across segments', () => {
    const pair = readingsFor('canalvine', lexicon, exact('nalv'))
    expect(pair.withoutWord?.segments).toEqual(['canal', 'vine'])
  })

  it('finds a numeric word inside a longer digit run and keeps it out of the other reading', () => {
    const pair = readingsFor('24680', lexicon, exact('2468'))
    expect(pair.withWord?.segments).toEqual(['2468', '0'])
    expect(pair.withoutWord).toBeNull()
  })

  it('places a word that starts with a digit', () => {
    const pair = readingsFor('vine4nal', lexicon, (span) => span === 'anal' || span === '4nal')
    expect(pair.withWord?.segments).toContain('4nal')
  })
})
