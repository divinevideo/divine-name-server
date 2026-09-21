-- ABOUTME: Adds child-safety terms to the username blocklist under a child_safety category

-- Terms are stored in canonical form, which is punycode for non-ASCII terms:
-- isReservedWord compares against a claim's canonical form, so a Unicode term
-- stored in its display form would never match the name it is meant to block.
-- The display form is given in a trailing comment for each encoded term.

INSERT OR IGNORE INTO reserved_words (word, category, reason, created_at) VALUES

-- English
('pedophile', 'child_safety', 'Child sexual abuse material', unixepoch()),
('pedophilia', 'child_safety', 'Child sexual abuse material', unixepoch()),
('paedo', 'child_safety', 'Child sexual abuse material', unixepoch()),
('paedophile', 'child_safety', 'Child sexual abuse material', unixepoch()),
('paedophilia', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kidporn', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kiddyporn', 'child_safety', 'Child sexual abuse material', unixepoch()),
('childsex', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kidsex', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kidsfuck', 'child_safety', 'Child sexual abuse material', unixepoch()),
('childfuck', 'child_safety', 'Child sexual abuse material', unixepoch()),
('childrape', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kidrape', 'child_safety', 'Child sexual abuse material', unixepoch()),
('infantrape', 'child_safety', 'Child sexual abuse material', unixepoch()),
('babyrape', 'child_safety', 'Child sexual abuse material', unixepoch()),
('toddlerporn', 'child_safety', 'Child sexual abuse material', unixepoch()),
('preteenporn', 'child_safety', 'Child sexual abuse material', unixepoch()),
('preteensex', 'child_safety', 'Child sexual abuse material', unixepoch()),
('underagesex', 'child_safety', 'Child sexual abuse material', unixepoch()),
('underageporn', 'child_safety', 'Child sexual abuse material', unixepoch()),
('tweenporn', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kindergartenporn', 'child_safety', 'Child sexual abuse material', unixepoch()),
('jailbait', 'child_safety', 'Child sexual abuse material', unixepoch()),

-- English, coded forms
('lolicon', 'child_safety', 'Child sexual abuse material', unixepoch()),
('shotacon', 'child_safety', 'Child sexual abuse material', unixepoch()),
('childlove', 'child_safety', 'Child sexual abuse material', unixepoch()),
('childlover', 'child_safety', 'Child sexual abuse material', unixepoch()),
('boylover', 'child_safety', 'Child sexual abuse material', unixepoch()),
('girllover', 'child_safety', 'Child sexual abuse material', unixepoch()),
('minorattracted', 'child_safety', 'Child sexual abuse material', unixepoch()),
('nomap', 'child_safety', 'Child sexual abuse material', unixepoch()),
('cheesepizza', 'child_safety', 'Child sexual abuse material', unixepoch()),
('pthc', 'child_safety', 'Child sexual abuse material', unixepoch()),
('hussyfan', 'child_safety', 'Child sexual abuse material', unixepoch()),
('raygold', 'child_safety', 'Child sexual abuse material', unixepoch()),

-- Spanish
('pedofilo', 'child_safety', 'Child sexual abuse material', unixepoch()),
('xn--pedfilo-n0a', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- pedófilo
('pedofilia', 'child_safety', 'Child sexual abuse material', unixepoch()),
('pederasta', 'child_safety', 'Child sexual abuse material', unixepoch()),
('pederastia', 'child_safety', 'Child sexual abuse material', unixepoch()),
('pornoinfantil', 'child_safety', 'Child sexual abuse material', unixepoch()),
('pornografiainfantil', 'child_safety', 'Child sexual abuse material', unixepoch()),
('sexoconninos', 'child_safety', 'Child sexual abuse material', unixepoch()),
('xn--sexoconnios-9db', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- sexoconniños
('abusoinfantil', 'child_safety', 'Child sexual abuse material', unixepoch()),
('violaninos', 'child_safety', 'Child sexual abuse material', unixepoch()),
('xn--violanios-r6a', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- violaniños
('menoresxxx', 'child_safety', 'Child sexual abuse material', unixepoch()),

-- Portuguese
('estuprodecrianca', 'child_safety', 'Child sexual abuse material', unixepoch()),
('estuproinfantil', 'child_safety', 'Child sexual abuse material', unixepoch()),
('sexocomcrianca', 'child_safety', 'Child sexual abuse material', unixepoch()),

-- French
('xn--pdophile-b1a', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- pédophile
('pedophilie', 'child_safety', 'Child sexual abuse material', unixepoch()),
('xn--pdophilie-b4a', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- pédophilie
('pornoenfant', 'child_safety', 'Child sexual abuse material', unixepoch()),
('pornographieinfantile', 'child_safety', 'Child sexual abuse material', unixepoch()),
('sexeavecenfant', 'child_safety', 'Child sexual abuse material', unixepoch()),
('violenfant', 'child_safety', 'Child sexual abuse material', unixepoch()),

-- German
('paedophil', 'child_safety', 'Child sexual abuse material', unixepoch()),
('xn--pdophil-5wa', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- pädophil
('paedophilie', 'child_safety', 'Child sexual abuse material', unixepoch()),
('xn--pdophilie-v2a', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- pädophilie
('kinderporno', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kinderpornografie', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kindersex', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kindficker', 'child_safety', 'Child sexual abuse material', unixepoch()),
('kindesmissbrauch', 'child_safety', 'Child sexual abuse material', unixepoch()),

-- Japanese
('xn--tckyfi0a', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- ロリコン
('xn--tckhy3nmc', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- ショタコン
('xn--ldk3a4b932tzp7b', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- 児童ポルノ
('xn--vusz0j', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- 幼女
('rorikon', 'child_safety', 'Child sexual abuse material', unixepoch()),
('jidouporuno', 'child_safety', 'Child sexual abuse material', unixepoch()),

-- Korean
('xn--2o2b2xo02c', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- 로리타
('xn--o80b38b9yht7nb0r', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- 아동포르노
('xn--oj4bng25hid', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- 소아성애
('ahdongporno', 'child_safety', 'Child sexual abuse material', unixepoch()),
('soaseongae', 'child_safety', 'Child sexual abuse material', unixepoch()),

-- Russian
('xn--d1abkmnd2b', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- педофил
('xn--d1acatqebbglfl', 'child_safety', 'Child sexual abuse material', unixepoch()),  -- детскоепорно
('pedofil', 'child_safety', 'Child sexual abuse material', unixepoch()),
('detskoeporno', 'child_safety', 'Child sexual abuse material', unixepoch());

-- childporn and kiddieporn were already present but filed as 'Foul Language ',
-- which handles them identically to ordinary profanity. Move them to the same
-- category as the terms above so the policy category is reportable as one set.
UPDATE reserved_words SET category = 'child_safety', reason = 'Child sexual abuse material'
WHERE word IN ('childporn', 'kiddieporn');
