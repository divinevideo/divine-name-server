// ABOUTME: Confirmation result page templates for email token confirmation
// ABOUTME: Shows success, already-used, expired, or invalid states

import { layout } from './layout'

export function confirmSuccess(nameCanonical: string, subscriptionExpiresAt: number): string {
  const expiryDate = new Date(subscriptionExpiresAt * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  })

  const body = `
    <div class="text-center mt-12">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-divine/20 mb-6">
        <svg class="w-8 h-8 text-divine" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
        </svg>
      </div>
      <h1 class="text-3xl font-bold mb-2">You're all set!</h1>
      <p class="text-xl text-gray-300 mb-6">
        <span class="text-divine font-semibold">@${escapeHtml(nameCanonical)}</span>.divine.video is yours.
      </p>

      <div class="bg-gray-900 border border-gray-700 rounded-lg p-6 max-w-md mx-auto text-left mb-8">
        <h2 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Your diVine Identity</h2>
        <dl class="space-y-3 text-sm">
          <div>
            <dt class="text-gray-500">NIP-05 Address</dt>
            <dd class="text-white font-mono">${escapeHtml(nameCanonical)}@divine.video</dd>
          </div>
          <div>
            <dt class="text-gray-500">Profile URL</dt>
            <dd><a href="https://${encodeURIComponent(nameCanonical)}.divine.video" class="text-divine hover:text-divine-400">${escapeHtml(nameCanonical)}.divine.video</a></dd>
          </div>
          <div>
            <dt class="text-gray-500">Reserved Until</dt>
            <dd class="text-white">${expiryDate}</dd>
          </div>
        </dl>
      </div>

      <div class="max-w-md mx-auto">
        <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Next Steps</h3>
        <div class="text-sm text-gray-300 space-y-2 text-left">
          <p>1. Download the <a href="https://divine.video" class="text-divine hover:text-divine-400">diVine app</a></p>
          <p>2. Sign in to link your Nostr key to this username</p>
          <p>3. Set <span class="font-mono text-divine">${escapeHtml(nameCanonical)}@divine.video</span> as your NIP-05 in your Nostr client</p>
        </div>
      </div>
    </div>
  `

  return layout({ title: `@${nameCanonical} Reserved — diVine Names`, body })
}

export function confirmAlreadyUsed(): string {
  const body = `
    <div class="text-center mt-12">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-yellow-500/20 mb-6">
        <svg class="w-8 h-8 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
        </svg>
      </div>
      <h1 class="text-2xl font-bold mb-2">Already Confirmed</h1>
      <p class="text-gray-400">This confirmation link has already been used.</p>
    </div>
  `

  return layout({ title: 'Already Confirmed — diVine Names', body })
}

export function confirmExpired(): string {
  const body = `
    <div class="text-center mt-12">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/20 mb-6">
        <svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
      </div>
      <h1 class="text-2xl font-bold mb-2">Link Expired</h1>
      <p class="text-gray-400 mb-6">This confirmation link has expired. Reservations must be confirmed within 48 hours.</p>
      <a href="/" class="inline-block px-6 py-2 bg-divine hover:bg-divine-600 text-white font-semibold rounded-lg transition-colors">
        Reserve Again
      </a>
    </div>
  `

  return layout({ title: 'Link Expired — diVine Names', body })
}

export function confirmInvalid(): string {
  const body = `
    <div class="text-center mt-12">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/20 mb-6">
        <svg class="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </div>
      <h1 class="text-2xl font-bold mb-2">Invalid Link</h1>
      <p class="text-gray-400 mb-6">This confirmation link is invalid or has already expired.</p>
      <a href="/" class="inline-block px-6 py-2 bg-divine hover:bg-divine-600 text-white font-semibold rounded-lg transition-colors">
        Reserve a Name
      </a>
    </div>
  `

  return layout({ title: 'Invalid Link — diVine Names', body })
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
