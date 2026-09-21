-- Migration 0015: give each reserved word its own matching rules.
--
-- Until now the check was whole-string equality, so reserving `admin` did
-- nothing against `ad-min`, `xadminx` or `myadmin`.
--
-- The rules are per word rather than global, or derived from a severity tier,
-- because neither of those survives contact with the registry. Measured over
-- all 179,450 active names: matching every word anywhere inside a name blocks
-- roughly three legitimate people for every violation it catches. Severity does
-- not predict that either -- `nazi` matched anywhere catches 28 violations
-- against 11 collisions, while `klan` and `aryan`, the same tier, catch nothing
-- at all and collide only with ordinary surnames ending in -kland and given
-- names built on Ryan and Ann.
--
-- Defaults are the safe end. Every existing word keeps today's behaviour apart
-- from tolerating separators inside itself, and every word added later starts
-- there too.

ALTER TABLE reserved_words ADD COLUMN match_scope TEXT NOT NULL DEFAULT 'whole';
ALTER TABLE reserved_words ADD COLUMN match_leet INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reserved_words ADD COLUMN match_digit_expand INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reserved_words ADD COLUMN match_repeats INTEGER NOT NULL DEFAULT 0;

-- Words that may match anywhere inside a name.
--
-- Each was measured individually against the registry. Every one catches more
-- violations than it costs real people, most of them at no cost at all:
-- `pussy` catches 14 more and collides with nobody, `n1gg4` catches 23 more
-- and collides with 3.
UPDATE reserved_words SET match_scope = 'anywhere' WHERE word IN (
  'analrape', 'boobs', 'elchapo', 'n1gg4', 'nigger', 'nudes',
  'pussy', 'pussypound', 'puta', 'tities', 'whore'
);

-- Words that may match a run of whole parts, but not inside a longer word.
--
-- These catch real violations at token scope and collide with nobody, but would
-- be destructive at `anywhere`: `anal` there lands on 165 registered people
-- (Arabic and Spanish given names, plus canal, analysis, analogue) to catch 8
-- more violations, and `rape` lands on 66 (grapefruit, draper, rapper) to catch 2.
--
-- `kkk` is the one marginal entry: one violation caught against one collision,
-- a punycode name that decodes to the Korean spelling of laughter. Included
-- because the catch is a hate-group reference; drop it to 'whole' if that trade
-- is the wrong one.
UPDATE reserved_words SET match_scope = 'token' WHERE word IN (
  'anal', 'cock', 'kkk', 'nazi', 'niger', 'puto', 'rape', 'tits'
);

-- Words stored already leetspelled need their digits read back as letters, or
-- they match only their own spelling and never the plain word. This is per word
-- because enabling it everywhere makes numeric codes such as `1488` and
-- `under18` match unrelated strings, including birth years.
UPDATE reserved_words SET match_digit_expand = 1 WHERE word IN (
  '2girls1cup', 'h1tler', 'h1tlerfan', 'n1gg4', 'realh1tlerfan'
);

-- Not changed here, but worth recording for whoever reads this next: `sa`, `ss`,
-- `12`, `14`, `111111` and `orion` are on the list and, measured against the
-- registry, catch nothing and collide with 55 real people between them. They are
-- inert at the default scope, so this migration leaves them alone rather than
-- deleting rows a moderator owns. They should not be loosened.
