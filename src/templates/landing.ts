// ABOUTME: Landing page template for names.divine.video
// ABOUTME: Hero section + real-time name search + reservation form with Cashu/invite payment

import { layout } from './layout'

export function landingPage(): string {
  const body = `
    <div class="text-center mt-8 mb-12">
      <h1 class="text-4xl sm:text-5xl font-bold mb-4">
        Claim your <span class="text-divine">@name</span>.divine.video
      </h1>
      <p class="text-lg text-gray-400 max-w-xl mx-auto">
        Get your unique Nostr identity on diVine. Use it as your NIP-05 address, profile URL, and more.
      </p>
    </div>

    <div class="max-w-lg mx-auto">
      <!-- Search -->
      <div class="relative mb-2">
        <input
          id="name-input"
          type="text"
          placeholder="Search for a name..."
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          class="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white text-lg
                 placeholder-gray-500 focus:outline-none focus:border-divine focus:ring-1 focus:ring-divine
                 transition-colors"
        >
        <div id="search-spinner" class="hidden absolute right-3 top-1/2 -translate-y-1/2">
          <svg class="animate-spin h-5 w-5 text-gray-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
        </div>
      </div>

      <!-- Result -->
      <div id="check-result" class="mb-6"></div>

      <!-- Reserve form (hidden initially) -->
      <div id="reserve-form" class="hidden fade-in">
        <div class="bg-gray-900 border border-gray-700 rounded-lg p-6">
          <h2 id="reserve-heading" class="text-lg font-semibold mb-4"></h2>

          <div class="mb-4">
            <label for="email-input" class="block text-sm text-gray-400 mb-1">Email address</label>
            <input
              id="email-input"
              type="email"
              placeholder="you@example.com"
              class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white
                     placeholder-gray-500 focus:outline-none focus:border-divine focus:ring-1 focus:ring-divine
                     transition-colors"
            >
            <p class="text-xs text-gray-500 mt-1">We'll send a confirmation link. Your email is never shared.</p>
          </div>

          <!-- Invite code input -->
          <div id="invite-field" class="mb-4">
            <label for="invite-input" class="block text-sm text-gray-400 mb-1">Invite code</label>
            <input
              id="invite-input"
              type="text"
              placeholder="Enter your invite code"
              class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white
                     placeholder-gray-500 focus:outline-none focus:border-divine focus:ring-1 focus:ring-divine
                     transition-colors"
            >
          </div>

          <button id="submit-btn" type="button"
            class="w-full py-3 bg-divine hover:bg-divine-600 text-white font-semibold rounded-lg
                   transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            Reserve Name
          </button>

          <div id="submit-result" class="mt-4"></div>
        </div>
      </div>
    </div>

  `

  const scripts = `<script>
(function() {
  const nameInput = document.getElementById('name-input');
  const spinner = document.getElementById('search-spinner');
  const checkResult = document.getElementById('check-result');
  const reserveForm = document.getElementById('reserve-form');
  const reserveHeading = document.getElementById('reserve-heading');
  const emailInput = document.getElementById('email-input');
  const inviteInput = document.getElementById('invite-input');
  const submitBtn = document.getElementById('submit-btn');
  const submitResult = document.getElementById('submit-result');

  let debounceTimer = null;
  let currentName = '';

  nameInput.addEventListener('input', function() {
    const val = nameInput.value.trim();
    clearTimeout(debounceTimer);
    submitResult.innerHTML = '';

    if (!val) {
      spinner.classList.add('hidden');
      checkResult.innerHTML = '';
      reserveForm.classList.add('hidden');
      currentName = '';
      return;
    }

    spinner.classList.remove('hidden');
    debounceTimer = setTimeout(function() { checkName(val); }, 300);
  });

  async function checkName(name) {
    currentName = name;
    try {
      const res = await fetch('/api/username/check/' + encodeURIComponent(name));
      const data = await res.json();
      spinner.classList.add('hidden');

      // If user typed something else while we were fetching, ignore
      if (nameInput.value.trim() !== name) return;

      if (data.available) {
        checkResult.innerHTML =
          '<div class="flex items-center gap-2 text-divine fade-in py-2">' +
            '<svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
              '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>' +
            '</svg>' +
            '<span><strong>' + escapeHtml(data.canonical || name) + '</strong> is available!</span>' +
          '</div>';

        reserveHeading.textContent = 'Reserve @' + (data.canonical || name) + '.divine.video';
        reserveForm.classList.remove('hidden');
      } else {
        checkResult.innerHTML =
          '<div class="flex items-center gap-2 text-red-400 fade-in py-2">' +
            '<svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
              '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>' +
            '</svg>' +
            '<span><strong>' + escapeHtml(data.canonical || name) + '</strong> ' +
            (data.reason ? '&mdash; ' + escapeHtml(data.reason) : 'is unavailable') + '</span>' +
          '</div>';
        reserveForm.classList.add('hidden');
      }
    } catch (err) {
      spinner.classList.add('hidden');
      checkResult.innerHTML =
        '<div class="text-red-400 py-2 fade-in">Error checking name. Please try again.</div>';
      reserveForm.classList.add('hidden');
    }
  }

  submitBtn.addEventListener('click', async function() {
    const name = currentName;
    const email = emailInput.value.trim();

    if (!name) return;
    if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
      submitResult.innerHTML = '<div class="text-red-400 text-sm">Please enter a valid email address.</div>';
      return;
    }

    const code = inviteInput.value.trim();
    if (!code) {
      submitResult.innerHTML = '<div class="text-red-400 text-sm">Please enter an invite code.</div>';
      return;
    }

    const payload = { name: name, email: email, invite_code: code };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Reserving...';
    submitResult.innerHTML = '';

    try {
      const res = await fetch('/api/username/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.ok) {
        submitResult.innerHTML =
          '<div class="bg-divine/10 border border-divine/30 rounded-lg p-4 fade-in">' +
            '<div class="flex items-center gap-2 text-divine font-semibold mb-1">' +
              '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
                '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>' +
              '</svg>' +
              'Check your email!' +
            '</div>' +
            '<p class="text-sm text-gray-300">We sent a confirmation link to <strong>' + escapeHtml(email) + '</strong>. ' +
            'Click it within 48 hours to complete your reservation.</p>' +
          '</div>';
        submitBtn.classList.add('hidden');
      } else {
        submitResult.innerHTML = '<div class="text-red-400 text-sm fade-in">' + escapeHtml(data.error || 'Something went wrong.') + '</div>';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Reserve Name';
      }
    } catch (err) {
      submitResult.innerHTML = '<div class="text-red-400 text-sm fade-in">Network error. Please try again.</div>';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Reserve Name';
    }
  });

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
})();
</script>`

  return layout({ title: 'diVine Names — Claim your @name.divine.video', body, scripts })
}
