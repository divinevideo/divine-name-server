import { skeleton } from 'namespace-guard'
import { getPotentialConfusableUsernames, type Username } from '../db/queries'

export type UsernameConfusableCandidate = Pick<
  Username,
  'name' | 'username_display' | 'username_canonical' | 'status' | 'reservation_expires_at'
>

export interface UsernameConfusableCollision {
  candidate: UsernameConfusableCandidate
  candidateCanonical: string
}

function getCandidateCanonical(candidate: UsernameConfusableCandidate): string | null {
  if (candidate.username_canonical && candidate.username_canonical.length > 0) {
    return candidate.username_canonical.toLowerCase()
  }

  if (candidate.name && candidate.name.length > 0) {
    return candidate.name.toLowerCase()
  }

  return null
}

function getCandidateSkeletonSource(candidate: UsernameConfusableCandidate): string | null {
  if (candidate.username_display && candidate.username_display.length > 0) {
    return candidate.username_display
  }

  if (candidate.username_canonical && candidate.username_canonical.length > 0) {
    return candidate.username_canonical
  }

  if (candidate.name && candidate.name.length > 0) {
    return candidate.name
  }

  return null
}

function isCandidateBlocking(
  candidate: UsernameConfusableCandidate,
  now = Math.floor(Date.now() / 1000)
): boolean {
  if (candidate.status === 'active' || candidate.status === 'reserved' || candidate.status === 'burned') {
    return true
  }

  if (candidate.status === 'pending-confirmation') {
    return candidate.reservation_expires_at === null || candidate.reservation_expires_at >= now
  }

  return false
}

export function toUsernameSkeleton(input: string): string {
  // Apply NFKC first so canonical equivalents collapse before skeleton mapping.
  return skeleton(input.normalize('NFKC'))
}

export async function getConfusableCollision(
  db: D1Database,
  nameDisplay: string,
  nameCanonical: string
): Promise<{ canonical: string; status: string } | null> {
  const candidates = await getPotentialConfusableUsernames(db)
  const collision = findUsernameConfusableCollision(nameDisplay, nameCanonical, candidates)
  if (!collision) {
    return null
  }

  return {
    canonical: collision.candidateCanonical,
    status: collision.candidate.status
  }
}

export function findUsernameConfusableCollision(
  display: string,
  canonical: string,
  candidates: UsernameConfusableCandidate[],
  now = Math.floor(Date.now() / 1000)
): UsernameConfusableCollision | null {
  const targetSkeleton = toUsernameSkeleton(display)

  for (const candidate of candidates) {
    if (!isCandidateBlocking(candidate, now)) {
      continue
    }

    const candidateCanonical = getCandidateCanonical(candidate)
    if (!candidateCanonical || candidateCanonical === canonical) {
      continue
    }

    const skeletonSource = getCandidateSkeletonSource(candidate)
    if (!skeletonSource) {
      continue
    }

    if (toUsernameSkeleton(skeletonSource) === targetSkeleton) {
      return {
        candidate,
        candidateCanonical
      }
    }
  }

  return null
}
