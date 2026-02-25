// ABOUTME: Shared HTML layout shell for public-facing pages
// ABOUTME: Dark theme with Tailwind CDN, brand color #00B488

interface LayoutOptions {
  title: string
  body: string
  scripts?: string
  meta?: string
}

export function layout({ title, body, scripts = '', meta = '' }: LayoutOptions): string {
  return `<!DOCTYPE html>
<html lang="en" class="bg-gray-950">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="Claim your @name.divine.video username on Nostr">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="Claim your @name.divine.video username on Nostr">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://names.divine.video">
  ${meta}
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            divine: {
              DEFAULT: '#00B488',
              50: '#e6f9f3',
              100: '#b3ede0',
              200: '#80e1cc',
              300: '#4dd5b9',
              400: '#26ccaa',
              500: '#00B488',
              600: '#009a74',
              700: '#007d5e',
              800: '#006049',
              900: '#004333',
            }
          }
        }
      }
    }
  </script>
  <style>
    @keyframes fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .fade-in { animation: fade-in 0.3s ease-out; }
  </style>
</head>
<body class="bg-gray-950 text-white min-h-screen flex flex-col">
  <header class="border-b border-gray-800">
    <div class="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
      <a href="/" class="text-xl font-bold text-divine hover:text-divine-400 transition-colors">
        diVine Names
      </a>
      <a href="https://divine.video" class="text-sm text-gray-400 hover:text-white transition-colors">
        divine.video
      </a>
    </div>
  </header>
  <main class="flex-1 max-w-3xl mx-auto px-4 py-8 w-full">
    ${body}
  </main>
  <footer class="border-t border-gray-800 py-6">
    <div class="max-w-3xl mx-auto px-4 text-center text-sm text-gray-500">
      &copy; ${new Date().getFullYear()} diVine &middot;
      <a href="https://divine.video" class="text-divine-500 hover:text-divine-400">divine.video</a>
    </div>
  </footer>
  ${scripts}
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
