// ABOUTME: The single client-side definition of what a username may look like
// ABOUTME: Every admin form imports these; none of them restate the rule

/**
 * Username rule for a form's `pattern` attribute.
 *
 * Letters, digits and hyphens, with no hyphen at either end. This mirrors the
 * ASCII half of `validateUsername` on the server, which is what makes a name
 * usable as a DNS label for `<name>.divine.video` and as an ATProto handle.
 *
 * Two details are load-bearing:
 *
 * - The hyphen is escaped. A form's `pattern` is compiled as `^(?:<pattern>)$`
 *   with the regex `v` flag, under which an unescaped hyphen at the end of a
 *   character class is a syntax error. A pattern that fails to compile is
 *   ignored outright rather than reported, so the form silently loses its check
 *   instead of failing loudly. Older browsers used the `u` flag, where the
 *   unescaped form is legal, so the bug is invisible on whichever browser
 *   happens to be to hand. The escaped form is valid under both.
 * - There are no anchors. The browser supplies them; adding our own would nest
 *   them pointlessly.
 *
 * This does not match the server rule exactly, in both directions, so do not
 * read "the form accepted it" as "the server will accept it":
 *
 * - Narrower on Unicode. The server also accepts non-ASCII names and
 *   canonicalises them to punycode; a form `pattern` cannot express that. See #93.
 * - Broader on the IDNA positions-3-and-4 rule. The server rejects a name with
 *   hyphens at both positions unless it starts `xn--`, so `ab--cd` passes here
 *   and is refused with a 400. Encoding that in a form pattern would cost more
 *   legibility than it buys, and the server is authoritative regardless.
 */
export const USERNAME_INPUT_PATTERN = '[A-Za-z0-9]([A-Za-z0-9\\-]{0,61}[A-Za-z0-9])?'

/** Browser validation message for {@link USERNAME_INPUT_PATTERN}. */
export const USERNAME_INPUT_TITLE =
  'Letters, numbers and hyphens, not starting or ending with a hyphen'

/** Shortest username the server will accept. */
export const USERNAME_MIN_LENGTH = 1

/** Longest username the server will accept, set by the 63-octet DNS label limit. */
export const USERNAME_MAX_LENGTH = 63
