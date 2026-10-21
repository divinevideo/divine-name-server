import { afterEach, describe, expect, it, vi } from 'vitest'
import { JudgmentUnavailable, judgeIntent, judgeProposal, type JudgmentAI } from './judgment'

const ask = (ai: JudgmentAI) => judgeIntent(ai, 'zxqwordextra', 'zxqword', 'zxqword extra', 'zx qword extra')
const aiWith = (answer: unknown): JudgmentAI => ({ run: async () => answer })
const result = (noul: unknown) => ({ model: 'clef', answers: { meant: { type: 'noul', noul } } })

afterEach(() => vi.useRealTimers())

describe('Workers AI judgment', () => {
  it('uses Clef, one question and the supplied readings', async () => {
    const run = vi.fn().mockResolvedValue(result(0.82))
    expect(await ask({ run })).toEqual({ noul: 0.82 })
    expect(run).toHaveBeenCalledWith('@cf/cloudflare/clef', expect.objectContaining({
      model: 'clef',
      state: {
        username: 'zxqwordextra', flagged_word: 'zxqword',
        reading_if_word_is_intended: 'zxqword extra',
        reading_if_word_is_accidental: 'zx qword extra',
      },
    }))
    expect(Object.keys(run.mock.calls[0][1].questions)).toEqual(['meant'])
  })

  it('asks about a proposal with only the word in state', async () => {
    const run = vi.fn().mockResolvedValue({ model: 'clef', answers: { belongs: { type: 'noul', noul: 0.9 } } })
    expect(await judgeProposal({ run }, 'zxqword')).toEqual({ noul: 0.9 })
    expect(run.mock.calls[0][1].state).toEqual({ word: 'zxqword' })
    expect(Object.keys(run.mock.calls[0][1].questions)).toEqual(['belongs'])
  })

  it.each([undefined, null, '0.9', -0.1, 1.1, NaN, Infinity])('refuses invalid score %s', async (score) => {
    await expect(ask(aiWith(result(score)))).rejects.toBeInstanceOf(JudgmentUnavailable)
  })

  it.each([
    null, {}, { model: 'clef', answers: {} },
    { model: 'clef-flash', answers: { meant: { type: 'noul', noul: 0.1 } } },
    { model: 'clef', answers: { meant: { type: 'score', noul: 0.1 } } },
    { model: 'clef', answers: { belongs: { type: 'noul', noul: 0.1 } } },
  ])('refuses a malformed or wrong-question answer', async (payload) => {
    await expect(ask(aiWith(payload))).rejects.toBeInstanceOf(JudgmentUnavailable)
  })

  it('refuses a configured binding failure', async () => {
    await expect(ask({ run: async () => { throw new Error('unreachable') } })).rejects.toBeInstanceOf(JudgmentUnavailable)
  })

  it('refuses a timeout without retrying', async () => {
    vi.useFakeTimers()
    const run = vi.fn(() => new Promise<never>(() => {}))
    const pending = expect(ask({ run })).rejects.toBeInstanceOf(JudgmentUnavailable)
    await vi.advanceTimersByTimeAsync(8000)
    await pending
    expect(run).toHaveBeenCalledTimes(1)
  })
})
