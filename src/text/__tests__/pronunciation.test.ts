import { describe, expect, it } from "vitest";
import { applyPronunciation } from "../pronunciation.js";
import {
  ACRONYM_MAP,
  EXACT_ACRONYMS,
  MIN_STEM_KEY_LENGTH,
  PRONUNCIATION_MAP,
  PRONUNCIATION_PASSES,
} from "../presets/pl.js";
import { PROSE_WITHOUT_ACRONYMS } from "./prose-without-acronyms.js";

describe("applyPronunciation — per-language maps", () => {
  it("pl preset respells English terms", () => {
    expect(applyPronunciation("deploy na produkcji", "pl")).toBe("diploj na produkcji");
  });

  it("no language or unknown language leaves text unchanged", () => {
    const text = "deploy na produkcji, CI/CD i API";
    expect(applyPronunciation(text, undefined)).toBe(text);
    expect(applyPronunciation(text, "de")).toBe(text);
    // An inherited Object key is not a language.
    expect(applyPronunciation(text, "constructor")).toBe(text);
  });

  it("app entries extend the preset", () => {
    const maps = { pl: { pavilio: "pawilio", kafka: { say: "kafka", match: "word" as const } } };
    expect(applyPronunciation("pavilio robi deploy", "pl", maps)).toBe("pawilio robi diploj");
    // A passed map for a language without a preset is used on its own.
    expect(applyPronunciation("pavilio deploy", "de", { de: { pavilio: "pawilio" } })).toBe("pawilio deploy");
    // A bare string entry matches the whole word only.
    expect(applyPronunciation("paviliowy", "pl", maps)).toBe("paviliowy");
    // An app entry may opt into stem mode and override a preset entry.
    expect(
      applyPronunciation("pavilia i deploy", "pl", { pl: { pavili: { say: "pawili", match: "stem" }, deploy: "deploj" } }),
    ).toBe("pawilia i deploj");
  });

  it("short keys do not rewrite longer words", () => {
    expect(applyPronunciation("Nasza macierz i codebase rosną", "pl")).toBe("Nasza macierz i codebase rosną");
    expect(applyPronunciation("nowy Mac pisze code", "pl")).toBe("nowy mak pisze koud");
  });

  it("ordinary prose survives the pl preset", () => {
    const rewritten = PROSE_WITHOUT_ACRONYMS.filter((sentence) => applyPronunciation(sentence, "pl") !== sentence);
    expect(rewritten).toEqual([]);
  });
});

// Ported from motyl.dev (lib/tts/pronunciation.test.ts and the pronunciation blocks of
// lib/tts/speech.test.ts at ddff0e4) — unchanged except import paths and the `lang` argument.
describe('PRONUNCIATION_MAP', () => {
  it('contains the migrated and new entries with lowercase keys', () => {
    expect(PRONUNCIATION_MAP.benchmark).toBe('benczmark')
    expect(PRONUNCIATION_MAP.react).toBe('reakt')
    expect(PRONUNCIATION_MAP.microsoft).toBe('mikrosoft')
  })
})

describe('applyPronunciation', () => {
  it('replaces the stem and preserves Polish inflection suffixes', () => {
    expect(applyPronunciation('benchmark', 'pl')).toBe('benczmark')
    expect(applyPronunciation('benchmarki', 'pl')).toBe('benczmarki')
    expect(applyPronunciation('benchmarków', 'pl')).toBe('benczmarków')
    expect(applyPronunciation('benchmarkiem', 'pl')).toBe('benczmarkiem')
    expect(applyPronunciation('benchmarkingu', 'pl')).toBe('benczmarkingu')
  })

  it('matches case-insensitively while lowercasing the stem', () => {
    expect(applyPronunciation('Benchmarki', 'pl')).toBe('benczmarki')
    expect(applyPronunciation('React', 'pl')).toBe('reakt')
    expect(applyPronunciation('react', 'pl')).toBe('reakt')
    expect(applyPronunciation('Microsoft', 'pl')).toBe('mikrosoft')
  })

  it('does not transform a key that is not at a word start', () => {
    expect(applyPronunciation('arbenchmark', 'pl')).toBe('arbenchmark')
  })

  it('transforms multiple occurrences in a sentence', () => {
    expect(applyPronunciation('Nowe benchmarki Reacta', 'pl')).toBe('Nowe benczmarki reakta')
  })

  it('fixes English c-words (Polish would read leading "c" as "ts")', () => {
    expect(applyPronunciation('cache', 'pl')).toBe('kesz')
    expect(applyPronunciation("cache'owania", 'pl')).toBe("kesz'owania")
    expect(applyPronunciation('commit', 'pl')).toBe('komit')
    expect(applyPronunciation('commitowanego', 'pl')).toBe('komitowanego')
    expect(applyPronunciation('Cursora', 'pl')).toBe('kersora')
  })

  it('applies the codex guard before the shorter code stem (longest-first)', () => {
    expect(applyPronunciation('Codex', 'pl')).toBe('kodeks')
    expect(applyPronunciation('Claude Code', 'pl')).toBe('klod koud')
  })

  it('applies cloudflare before the shorter cloud stem', () => {
    expect(applyPronunciation('Cloudflare', 'pl')).toBe('klałdfler')
    expect(applyPronunciation('Google Cloud', 'pl')).toBe('Google klałd')
  })

  it('matches multi-word phrase keys and preserves inflection', () => {
    expect(applyPronunciation('pull requesty', 'pl')).toBe('pul rikłesty')
    expect(applyPronunciation('open source', 'pl')).toBe('oupen sors')
    expect(applyPronunciation('Hugging Face', 'pl')).toBe('haging fejs')
  })

  it('does not corrupt the Polish word "facet" (no bare face stem)', () => {
    expect(applyPronunciation('facet', 'pl')).toBe('facet')
  })

  it('speaks chunk as czank', () => {
    expect(applyPronunciation('chunk', 'pl')).toBe('czank')
  })

  it('preserves Polish inflection on chunk (chunki, chunków, chunkiem)', () => {
    expect(applyPronunciation('chunki', 'pl')).toBe('czanki')
    expect(applyPronunciation('chunków', 'pl')).toBe('czanków')
    expect(applyPronunciation('chunkiem', 'pl')).toBe('czankiem')
  })

  it('maps chunk case-insensitively', () => {
    expect(applyPronunciation('Chunk', 'pl')).toBe('czank')
    expect(applyPronunciation('CHUNK', 'pl')).toBe('czank')
    expect(applyPronunciation('Chunki', 'pl')).toBe('czanki')
  })

  it('preserves Polish inflection on new stems', () => {
    expect(applyPronunciation('frameworku', 'pl')).toBe('frejmłerku')
    expect(applyPronunciation('deploya', 'pl')).toBe('diploja')
    expect(applyPronunciation('bugi', 'pl')).toBe('bagi')
  })
})
// Assert against the map's own values so ear-tuning the spellings never breaks
// these behavioral tests.
describe('applyPronunciation — whole-word acronyms (ACRONYM_MAP)', () => {
  it('replaces a standalone acronym with its mapped spelling', () => {
    expect(applyPronunciation('Użyj CLI do tego', 'pl')).toBe(`Użyj ${ACRONYM_MAP.cli} do tego`)
    expect(applyPronunciation('nowe API i GPU', 'pl')).toContain(ACRONYM_MAP.api)
    expect(applyPronunciation('nowe API i GPU', 'pl')).toContain(ACRONYM_MAP.gpu)
  })

  it('handles multi-token acronyms containing a slash (CI/CD)', () => {
    expect(applyPronunciation('nasz CI/CD tutaj', 'pl')).toBe(
      `nasz ${ACRONYM_MAP['ci/cd']} tutaj`
    )
  })

  it('does NOT corrupt normal words that start with an acronym (client/click)', () => {
    const out = applyPronunciation('client kliknął, potem click i clipboard', 'pl')
    expect(out).toContain('client')
    expect(out).toContain('click')
    expect(out).toContain('clipboard')
    expect(out).not.toContain(ACRONYM_MAP.cli)
  })

  it('handles a trailing plural s but not a longer suffix', () => {
    expect(applyPronunciation('mamy dwa GPUs', 'pl')).toBe(`mamy dwa ${ACRONYM_MAP.gpu}s`)
    // Not a standalone word (Polish diacritic follows) → left untouched.
    expect(applyPronunciation('CLIą', 'pl')).toBe('CLIą')
  })

  it('word-style acronym (JSON) uses its mapped token', () => {
    expect(applyPronunciation('zwraca JSON', 'pl')).toBe(`zwraca ${ACRONYM_MAP.json}`)
  })

  it('is case-insensitive', () => {
    expect(applyPronunciation('cli i Cli i CLI', 'pl')).toBe(
      `${ACRONYM_MAP.cli} i ${ACRONYM_MAP.cli} i ${ACRONYM_MAP.cli}`
    )
  })
})

// Polish "ci" ("mówię ci to") and "cd." ("ciąg dalszy") are ordinary words that
// spell the acronyms CI and CD; "ide" is a verb form ("ide do domu"). Measured
// over the corpus the uppercase spelling dominates (CI 630/99, CD 157/15,
// IDE 245/16, PR 538/7, QA 83/9) AND the error is asymmetric: a missed
// lowercase "ci failed" merely reads as Polish, while a case-insensitive `ci`
// would demolish every Polish "ci". Hence a case-SENSITIVE pass.
// Expected values are written out literally: interpolating the map would make
// these tests pass against a map that lost the entry.
describe('applyPronunciation — case-sensitive acronyms (EXACT_ACRONYMS)', () => {
  it('an exact acronym is pronounced in uppercase', () => {
    expect(applyPronunciation('CI failed again', 'pl')).toBe('si aj failed again')
    expect(applyPronunciation('nowe IDE', 'pl')).toBe('nowe aj di i')
    expect(applyPronunciation('otwórz PR', 'pl')).toBe('otwórz pi ar')
    expect(applyPronunciation('zespół QA', 'pl')).toBe('zespół kju ej')
  })

  it('an exact acronym leaves its lowercase Polish homograph alone', () => {
    expect(applyPronunciation('mówię ci to teraz', 'pl')).toBe('mówię ci to teraz')
    expect(applyPronunciation('cd. nastąpi w kolejnym wpisie', 'pl')).toBe(
      'cd. nastąpi w kolejnym wpisie'
    )
    expect(applyPronunciation('ide do domu', 'pl')).toBe('ide do domu')
  })

  it('an exact acronym leaves the Polish polite capitalised form alone', () => {
    // Polite Polish capitalises only the first letter: "Ci", never "CI".
    expect(applyPronunciation('Mówię Ci to', 'pl')).toBe('Mówię Ci to')
  })

  it('the compound ci/cd key still wins over the bare CI acronym', () => {
    expect(applyPronunciation('nasz CI/CD działa', 'pl')).toBe('nasz si aj si di działa')
    expect(applyPronunciation('CI/CD i CI razem', 'pl')).toBe('si aj si di i si aj razem')
  })

  // The plural is the same acronym. Word mode has always carried an optional
  // trailing "s", so moving a key into the exact pass must not drop it: "PRs"
  // occurs 201 times in the corpus and "IDEs" 33, and both were pronounced
  // before these keys became case-sensitive.
  it('a plural of a case-sensitive acronym is still pronounced', () => {
    expect(applyPronunciation('dwa PRs czekają', 'pl')).toBe('dwa pi ars czekają')
    expect(applyPronunciation('zamknąłem PRs.', 'pl')).toBe('zamknąłem pi ars.')
    expect(applyPronunciation('nowe IDEs', 'pl')).toBe('nowe aj di is')
    expect(applyPronunciation('dwa QAs i CIs', 'pl')).toBe('dwa kju ejs i si ajs')
  })

  // The counter-case: the plural group must not smuggle in case-insensitivity.
  it('a lowercase plural of a case-sensitive acronym stays an ordinary word', () => {
    expect(applyPronunciation('prs', 'pl')).toBe('prs')
    expect(applyPronunciation('ides', 'pl')).toBe('ides')
    expect(applyPronunciation('cis jest przed d', 'pl')).toBe('cis jest przed d')
    // Uppercase is the whole key, so "PRS" is not "PR" + a plural either.
    expect(applyPronunciation('PRS', 'pl')).toBe('PRS')
  })
})

// A stem key replaces a word PREFIX and re-appends whatever letters follow, with
// no idea where the word ends. Short keys therefore swallow ordinary words that
// merely start with them — `mac` turned "machine" into "makhine". Those keys
// belong in ACRONYM_MAP, which matches the whole word only.
describe('applyPronunciation — short keys match whole words, not prefixes', () => {
  it('a short key no longer rewrites a longer word that starts with it', () => {
    expect(applyPronunciation('macierz kowariancji rośnie', 'pl')).toBe('macierz kowariancji rośnie')
    expect(applyPronunciation('Nasz codebase rośnie', 'pl')).toBe('Nasz codebase rośnie')
    expect(applyPronunciation('ainews dzisiaj', 'pl')).toBe('ainews dzisiaj')
    // "machine" is left alone; "macOS" is pronounced from its own word entry.
    expect(applyPronunciation('machine learning i macOS', 'pl')).toBe(
      `machine learning i ${ACRONYM_MAP.macos}`
    )
  })

  it('a short key still rewrites the bare word', () => {
    expect(applyPronunciation('nowy Mac i AI', 'pl')).toBe(
      `nowy ${ACRONYM_MAP.mac} i ${ACRONYM_MAP.ai}`
    )
    expect(applyPronunciation('GPT pisze code', 'pl')).toBe(
      `${ACRONYM_MAP.gpt} pisze ${ACRONYM_MAP.code}`
    )
  })

  // Word mode only matches the bare word, so demoting a short key also dropped
  // the Polish inflections it used to catch as a stem. Those come back as
  // explicit word-mode entries — one per form that actually occurs in the corpus.
  it('Polish inflections of a demoted short key are pronounced from explicit entries', () => {
    expect(applyPronunciation('bugi', 'pl')).toBe('bagi')
    expect(applyPronunciation('bugów', 'pl')).toBe('bagów')
    expect(applyPronunciation('buga', 'pl')).toBe('baga')
    expect(applyPronunciation('bugiem', 'pl')).toBe('bagiem')
    expect(applyPronunciation('buggy', 'pl')).toBe('bagi')
    expect(applyPronunciation('hooki', 'pl')).toBe('huki')
    expect(applyPronunciation('hooków', 'pl')).toBe('huków')
    expect(applyPronunciation('hooka', 'pl')).toBe('huka')
    expect(applyPronunciation('hookami', 'pl')).toBe('hukami')
    expect(applyPronunciation('hookach', 'pl')).toBe('hukach')
    expect(applyPronunciation('edges', 'pl')).toBe('edżes')
    expect(applyPronunciation('Naprawiamy bugi i hooki', 'pl')).toBe('Naprawiamy bagi i huki')
  })

  // The first sweep for these forms asked whether a guessed word list occurred
  // instead of asking the corpus which forms it contains, so these measured
  // ones stayed silent: hookiem 4, hooku 3, bugami 3, Maca 8, Maców 3.
  it('pronounces the inflections the first measurement missed', () => {
    expect(applyPronunciation('hookiem', 'pl')).toBe('hukiem')
    expect(applyPronunciation('hooku', 'pl')).toBe('huku')
    expect(applyPronunciation('bugami', 'pl')).toBe('bagami')
    // Capitalised in the corpus; the map is case-insensitive, so both spellings
    // land on the same lowercase value.
    expect(applyPronunciation('bez Maca', 'pl')).toBe('bez maka')
    expect(applyPronunciation('kilka Maców', 'pl')).toBe('kilka maków')
    expect(applyPronunciation('maca', 'pl')).toBe('maka')
  })

  it("English plurals of a demoted short key still come from the base key's plural group", () => {
    expect(applyPronunciation('bugs', 'pl')).toBe('bags')
    expect(applyPronunciation('hooks', 'pl')).toBe('huks')
    // The bare words keep working too — the explicit forms do not shadow them.
    expect(applyPronunciation('bug', 'pl')).toBe('bag')
    expect(applyPronunciation('hook', 'pl')).toBe('huk')
    expect(applyPronunciation('edge', 'pl')).toBe('edż')
  })
})

// A stem replaces the prefix it matched and keeps the rest of the word, so a
// shorter stem inside a compound leaves the tail unspoken: `tailwind` turned
// "tailwindcss" into "tejlłindcss" and `claude` turned "claudecode" into
// "klodcode". The fix is an explicit longer key — longest-key-first makes it win
// — and stem mode keeps Polish endings attaching to it.
describe('applyPronunciation — compounds whose tail a shorter stem swallowed', () => {
  it('pronounces the css tail of tailwindcss', () => {
    expect(applyPronunciation('tailwindcss', 'pl')).toBe(
      `${PRONUNCIATION_MAP.tailwind} ${ACRONYM_MAP.css}`
    )
    expect(applyPronunciation('Piszemy w TailwindCSS dzisiaj', 'pl')).toBe(
      `Piszemy w ${PRONUNCIATION_MAP.tailwind} ${ACRONYM_MAP.css} dzisiaj`
    )
  })

  it('pronounces the code tail of claudecode', () => {
    expect(applyPronunciation('claudecode', 'pl')).toBe(
      `${PRONUNCIATION_MAP.claude} ${ACRONYM_MAP.code}`
    )
    expect(applyPronunciation('ClaudeCode robi to sam', 'pl')).toBe(
      `${PRONUNCIATION_MAP.claude} ${ACRONYM_MAP.code} robi to sam`
    )
  })

  it('keeps a Polish ending on the new compound keys', () => {
    expect(applyPronunciation('claudecodem', 'pl')).toBe(
      `${PRONUNCIATION_MAP.claude} ${ACRONYM_MAP.code}m`
    )
  })

  // The guard on the fix: a new longer key must not shadow any shorter word it
  // contains. These outputs are pinned to what they were before the two entries
  // were added.
  it('does not shadow the shorter words the new keys contain', () => {
    expect(applyPronunciation('cloud', 'pl')).toBe('klałd')
    expect(applyPronunciation('cloudflare', 'pl')).toBe('klałdfler')
    expect(applyPronunciation('commit', 'pl')).toBe('komit')
    expect(applyPronunciation('commitment', 'pl')).toBe('komitment')
    expect(applyPronunciation('tailwind', 'pl')).toBe('tejlłind')
    expect(applyPronunciation('claude', 'pl')).toBe('klod')
  })
})

// The guard against the NEXT collision, not the ones already fixed. Every map
// key is a prefix rule, so any new entry can quietly start rewriting ordinary
// prose; this pins that it does not.
describe('applyPronunciation — ordinary prose survives the maps', () => {
  it('ordinary prose with no acronyms passes through applyPronunciation unchanged', () => {
    const rewritten = PROSE_WITHOUT_ACRONYMS.map((sentence) => ({
      sentence,
      spoken: applyPronunciation(sentence, 'pl'),
    })).filter(({ sentence, spoken }) => spoken !== sentence)

    // Asserted as a joined report rather than per-sentence, so ONE failure
    // lists every offending sentence with what it became — enough to act on
    // without a debugger.
    expect(
      rewritten.map(({ sentence, spoken }) => `${sentence}\n  became: ${spoken}`).join('\n'),
      'applyPronunciation rewrote prose that contains nothing to pronounce. ' +
        'Fix this by adding an explicit pronunciation entry for the offending ' +
        'word — never by editing the fixture sentence.'
    ).toBe('')
  })
})

// The maps carry the looseness of their own match mode, so these invariants are
// the net: a key in the wrong map silently changes how loosely it matches.
describe('pronunciation map invariants', () => {
  it('every stem key is at least MIN_STEM_KEY_LENGTH characters', () => {
    const tooShort = Object.keys(PRONUNCIATION_MAP).filter(
      (key) => key.length < MIN_STEM_KEY_LENGTH
    )

    expect(
      tooShort,
      `PRONUNCIATION_MAP keys shorter than MIN_STEM_KEY_LENGTH (${MIN_STEM_KEY_LENGTH}) match as a stem and swallow longer words: ${tooShort.join(', ')}. Move them to ACRONYM_MAP (word) or EXACT_ACRONYMS (exact).`
    ).toEqual([])
  })

  it('every exact-acronym key is uppercase', () => {
    const notUppercase = Object.keys(EXACT_ACRONYMS).filter((key) => key !== key.toUpperCase())

    expect(
      notUppercase,
      `EXACT_ACRONYMS is matched case-sensitively, so a lowercase key can never match: ${notUppercase.join(', ')}`
    ).toEqual([])
  })

  it('no key appears in more than one pronunciation map', () => {
    const named: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
      ['ACRONYM_MAP', ACRONYM_MAP],
      ['PRONUNCIATION_MAP', PRONUNCIATION_MAP],
      ['EXACT_ACRONYMS', EXACT_ACRONYMS],
    ]
    const owners = new Map<string, string[]>()
    for (const [mapName, map] of named) {
      for (const key of Object.keys(map)) {
        const lower = key.toLowerCase()
        owners.set(lower, [...(owners.get(lower) ?? []), mapName])
      }
    }
    const duplicated = [...owners.entries()]
      .filter(([, maps]) => maps.length > 1)
      .map(([key, maps]) => `${key} (${maps.join(' + ')})`)

    expect(
      duplicated,
      `a key may only live in one map — its map decides how loosely it matches: ${duplicated.join('; ')}`
    ).toEqual([])
  })

  it('letter-by-letter values are space-separated, not hyphenated', () => {
    // Values only (a key like `type-aware` is matched text, not speech). No value
    // is a genuinely hyphenated word, so a hyphen between two letters can only be
    // letter names glued together ("si-aj") — the voice blurs those; spaces make
    // it read separate letters ("si aj"). Punctuation-only values (",,", "..")
    // have no letters, so they never match.
    const hyphenated = PRONUNCIATION_PASSES.flatMap(({ map }) =>
      Object.entries(map)
        .filter(([, say]) => /\p{L}-\p{L}/u.test(say))
        .map(([key, say]) => `${key}: '${say}'`)
    )

    expect(
      hyphenated,
      `spell letter-by-letter acronyms with spaces, not hyphens: ${hyphenated.join(', ')}`
    ).toEqual([])
  })

  it('applyPronunciation applies word, stem and exact modes in that order', () => {
    expect(PRONUNCIATION_PASSES.map((pass) => pass.mode)).toEqual(['word', 'stem', 'exact'])
    expect(PRONUNCIATION_PASSES.map((pass) => pass.map)).toEqual([
      ACRONYM_MAP,
      PRONUNCIATION_MAP,
      EXACT_ACRONYMS,
    ])
    // Behavioural, not just declarative: the assertion above only describes the
    // list, so the one below pins the order the list is actually CONSUMED in.
    // The `ci/cd` word key must consume "CI/CD" whole before a bare `CI` exact
    // key could split it — consume the passes in reverse and this reads
    // "si aj/si di" instead.
    expect(applyPronunciation('nasz CI/CD działa', 'pl')).toBe('nasz si aj si di działa')
    expect(applyPronunciation('CI/CD i CI razem', 'pl')).toBe('si aj si di i si aj razem')
  })
})

// Heard on the motyl reader: "Działa na JS i WebGPU" came out letter by letter in
// English ("jot es i web gie pe uu") — `js` had no entry and the whole-word `gpu`
// cannot match inside "WebGPU".
describe('applyPronunciation — JS, WebGPU, WebGL and JavaScript', () => {
  it('pronounces JS and WebGPU in the heard sentence', () => {
    expect(applyPronunciation('Działa na JS i WebGPU, ', 'pl')).toBe('Działa na dżej es i łeb dżi pi ju, ')
  })

  it('pronounces WebGL, JavaScript (with Polish inflection) and a .js suffix', () => {
    expect(applyPronunciation('WebGL', 'pl')).toBe('łeb dżi el')
    expect(applyPronunciation('JavaScript', 'pl')).toBe('dżawaskrypt')
    expect(applyPronunciation('JavaScriptu', 'pl')).toBe('dżawaskryptu')
    expect(applyPronunciation('Next.js', 'pl')).toBe('Next.dżej es')
    expect(applyPronunciation('Vue.js', 'pl')).toBe('Vue.dżej es')
  })

  it('leaves the existing js-bearing and gpu entries as they were', () => {
    expect(applyPronunciation('Node.js', 'pl')).toBe('noud dżej es')
    expect(applyPronunciation('NodeJS', 'pl')).toBe('noud dżej es')
    expect(applyPronunciation('JS/TS', 'pl')).toBe('dżej es / ti es')
    expect(applyPronunciation('JSON', 'pl')).toBe('dżejson')
    expect(applyPronunciation('GPU', 'pl')).toBe('dżi pi ju')
    expect(applyPronunciation('TypeScript', 'pl')).toBe('tajpskrypt')
  })
})

describe('applyPronunciation — YAML', () => {
  it('reads YAML as one word, in any case and with a hyphenated ending', () => {
    expect(applyPronunciation('plik YAML', 'pl')).toBe('plik jaml')
    expect(applyPronunciation('config.yaml', 'pl')).toBe('config.jaml')
    expect(applyPronunciation('w YAML-u', 'pl')).toBe('w jaml-u')
  })
})

describe('applyPronunciation — corpus acronyms, space-separated letters', () => {
  it('reads a spelled acronym as separate letters', () => {
    expect(applyPronunciation('serwer MCP i RAG', 'pl')).toBe('serwer em si pi i er ej dżi')
    expect(applyPronunciation('testy E2E i OIDC', 'pl')).toBe('testy end tu end i oł aj di si')
    expect(applyPronunciation('CDN-y i SVGs', 'pl')).toBe('si di en-y i es wi dżis')
  })

  it('reads a word-style acronym as one word', () => {
    expect(applyPronunciation('WASM, CRUD i README', 'pl')).toBe('łazem, krad i ridmi')
  })

  it('VS Code beats the bare vs', () => {
    expect(applyPronunciation('VS Code vs Cursor', 'pl')).toBe('wi es koud wersus kersor')
  })

  it('HTTPS is spelled out, not read as a plural of HTTP', () => {
    expect(applyPronunciation('HTTPS', 'pl')).toBe('ejcz ti ti pi es')
    expect(applyPronunciation('https', 'pl')).toBe('ejcz ti ti pi es')
    expect(applyPronunciation('HTTP', 'pl')).toBe('ejcz ti ti pi')
  })

  it('pronounces the case-sensitive acronyms in uppercase', () => {
    expect(applyPronunciation('SWE, ML, MIT, IT, DX i V8', 'pl')).toBe(
      'es dabl ju i, em el, em aj ti, aj ti, di eks i wi ejt'
    )
  })

  it('leaves their lowercase homographs alone', () => {
    for (const text of ['swe dzieci', '200 ml mleka', 'to tylko mit', 'it works', 'Router v8']) {
      expect(applyPronunciation(text, 'pl')).toBe(text)
    }
  })
})
