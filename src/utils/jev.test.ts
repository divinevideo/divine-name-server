import { describe, expect, it } from 'vitest'
import { JevUnavailable, judgeIntent, type JevFetch } from './jev'

function respond(status: number, body: unknown): JevFetch {
  return async () => new Response(JSON.stringify(body), { status })
}

function ask(fetchImpl: JevFetch) {
  return judgeIntent('test-key', 'analvine', 'anal', 'anal vine', 'an al vine', fetchImpl)
}

describe('judgeIntent', () => {
  it('returns the score the service gives for the intent question', async () => {
    const result = await ask(respond(200, { answers: { meant: { noul: 0.82 } } }))
    expect(result.noul).toBe(0.82)
  })

  it('sends the key as a bearer token and the readings in the state', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const fetchImpl: JevFetch = async (url, init) => {
      seen = { url, init }
      return new Response(JSON.stringify({ answers: { meant: { noul: 0.1 } } }))
    }
    await ask(fetchImpl)
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const body = JSON.parse(String(seen?.init.body))
    expect(body.state).toEqual({
      username: 'analvine',
      flagged_word: 'anal',
      reading_if_word_is_intended: 'anal vine',
      reading_if_word_is_accidental: 'an al vine',
    })
  })

  // Each failure has to surface as JevUnavailable, which the caller turns into
  // a refusal. A failure that returned a result would be read as a verdict.
  it('fails on a non-2xx status', async () => {
    await expect(ask(respond(503, {}))).rejects.toBeInstanceOf(JevUnavailable)
  })

  it('fails when the answer has no score', async () => {
    await expect(ask(respond(200, { answers: {} }))).rejects.toBeInstanceOf(JevUnavailable)
  })

  it('fails when the score is not a number', async () => {
    await expect(
      ask(respond(200, { answers: { meant: { noul: '0.9' } } }))
    ).rejects.toBeInstanceOf(JevUnavailable)
  })

  it('fails when the service cannot be reached', async () => {
    const unreachable: JevFetch = async () => {
      throw new TypeError('network down')
    }
    await expect(ask(unreachable)).rejects.toBeInstanceOf(JevUnavailable)
  })
})
