// ABOUTME: Minimal declarations for the Node built-ins used by SQLite test helpers.
// ABOUTME: tsconfig pins `types` to workers-types, so @types/node is deliberately absent.

// The Worker runtime has none of these. Declaring just the surface the test
// helpers touch keeps `tsc --noEmit` clean without pulling ambient Node globals
// into the project and shadowing Cloudflare's.

declare module 'node:fs' {
  export function readdirSync(path: string): string[]
  export function readFileSync(path: string, encoding: string): string
}

declare module 'node:module' {
  export function createRequire(path: string): (id: string) => unknown
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

interface ImportMeta {
  url: string
}
