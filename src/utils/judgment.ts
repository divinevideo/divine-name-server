// ABOUTME: One typed decision through the Workers AI binding. A configured
// ABOUTME: judgment that times out or returns an invalid answer fails closed.

export const JUDGMENT_MODEL = '@cf/cloudflare/clef'
export const JUDGMENT_POLICY = 'clef-intent-v1'
const TIMEOUT_MS = 8000

export interface JudgmentCall {
  noul: number
}

export interface JudgmentAI {
  run(model: string, input: unknown): Promise<unknown>
}

export class JudgmentUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JudgmentUnavailable'
  }
}

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

async function runJudgment(
  ai: JudgmentAI,
  body: unknown,
  answerKey: 'meant' | 'belongs'
): Promise<JudgmentCall> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The binding has no documented cancellation option. Timing out refuses
    // the name; the reserved call budget is not refunded or retried.
    const payload = await Promise.race([
      ai.run(JUDGMENT_MODEL, body),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JudgmentUnavailable('judgment timeout')), TIMEOUT_MS)
      }),
    ]) as {
      model?: unknown
      answers?: Record<string, { type?: unknown; noul?: unknown }>
    }
    const answer = payload?.answers?.[answerKey]
    const noul = answer?.noul
    if (payload?.model !== 'clef' || answer?.type !== 'noul' ||
        typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new JudgmentUnavailable('judgment answer invalid')
    }
    return { noul }
  } catch (error) {
    if (error instanceof JudgmentUnavailable) throw error
    throw new JudgmentUnavailable('judgment unavailable')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** One question: which reading did the person mean. Readings are already enumerated. */
export function judgeIntent(
  ai: JudgmentAI,
  username: string,
  flaggedWord: string,
  intended: string,
  accidental: string
): Promise<JudgmentCall> {
  return runJudgment(ai, {
    model: 'clef',
    state: {
      username,
      flagged_word: flaggedWord,
      reading_if_word_is_intended: intended,
      reading_if_word_is_accidental: accidental,
    },
    questions: { meant: INTENT_QUESTION },
  }, 'meant')
}

/**
 * Separate call, word alone. A question about a different subject cannot ride
 * in the username call: the surrounding name moves the answer.
 */
export function judgeProposal(
  ai: JudgmentAI,
  word: string
): Promise<JudgmentCall> {
  return runJudgment(ai, {
    model: 'clef',
    state: { word },
    questions: { belongs: PROPOSE_QUESTION },
  }, 'belongs')
}
