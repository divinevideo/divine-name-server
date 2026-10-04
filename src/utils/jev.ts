// ABOUTME: One judgment call to TypeSafe Jev. A missing, slow, or bad answer is
// ABOUTME: not an allow — the caller fails closed.

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const JEV_TIMEOUT_MS = 8000

export interface JevCall {
  noul: number
}

export class JevUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JevUnavailable'
  }
}

export type JevFetch = (url: string, init: RequestInit) => Promise<Response>

const INTENT_QUESTION = {
  type: 'noul',
  instructions: 'Two readings of this username as ordinary words are given: one where flagged_word is a word the person chose, one where those letters are an accident of neighbouring words. Both are produced automatically and either may be nonsense. Decide which reading the person actually meant.',
  criteria: {
    true: 'The person meant flagged_word to be there.',
    false: 'The letters are an accident. They straddle the boundary between other words, or sit inside a name.',
  },
}

const PROPOSE_QUESTION = {
  type: 'noul',
  instructions: 'Would this word make any username unacceptable, no matter what surrounded it?',
  criteria: {
    true: 'It is a slur, an explicit sexual term, or a hate reference. It is unacceptable in every username.',
    false: 'It is ordinary in most contexts. Banning it outright would block innocent people.',
  },
}

async function postJev(
  apiKey: string,
  body: unknown,
  fetchImpl: JevFetch
): Promise<JevCall> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS)
  try {
    const response = await fetchImpl(JEV_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) throw new JevUnavailable(`jev status ${response.status}`)
    const payload = await response.json() as {
      answers?: { meant?: { noul?: unknown }; belongs?: { noul?: unknown } }
    }
    const noul = payload.answers?.meant?.noul ?? payload.answers?.belongs?.noul
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
      throw new JevUnavailable('jev answer missing')
    }
    return { noul }
  } catch (error) {
    if (error instanceof JevUnavailable) throw error
    throw new JevUnavailable('jev unreachable')
  } finally {
    clearTimeout(timer)
  }
}

/** One question: which reading did the person mean. Readings are already enumerated. */
export function judgeIntent(
  apiKey: string,
  username: string,
  flaggedWord: string,
  intended: string,
  accidental: string,
  fetchImpl: JevFetch
): Promise<JevCall> {
  return postJev(apiKey, {
    model: 'jev-latest',
    state: {
      username,
      flagged_word: flaggedWord,
      reading_if_word_is_intended: intended,
      reading_if_word_is_accidental: accidental,
    },
    questions: { meant: INTENT_QUESTION },
  }, fetchImpl)
}

/**
 * Separate call, word alone. A question about a different subject cannot ride
 * in the username call: the surrounding name moves the answer.
 */
export function judgeProposal(
  apiKey: string,
  word: string,
  fetchImpl: JevFetch
): Promise<JevCall> {
  return postJev(apiKey, {
    model: 'jev-latest',
    state: { word },
    questions: { belongs: PROPOSE_QUESTION },
  }, fetchImpl)
}
