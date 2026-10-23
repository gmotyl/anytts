// Polish pronunciation preset: English terms respelled for a Polish voice.
// Source: motyl.dev `lib/tts/pronunciation.ts` at ddff0e4 (main after PR #89,
// pronunciation-match-strictness). The three maps below are verbatim; the pass list
// moved here from motyl's `lib/tts/speech.ts`, and `plPreset` flattens it into one
// map whose entries carry their own match mode.
import type { PronunciationMap, PronunciationMatchMode } from '../pronunciation.js'

/**
 * English → Polish phonetic pronunciation map for TTS.
 *
 * HOW TO EDIT: add `'englishStem': 'polishPhonetic'` entries below. Matching is
 * case-insensitive and stem-based: the key is matched at a word start and any
 * trailing Polish inflection is preserved. E.g. 'benchmark':'benczmark' turns
 * "benchmarki" into "benczmarki". Values should be lowercase Polish phonetic spelling.
 */
export const PRONUNCIATION_MAP: Readonly<Record<string, string>> = Object.freeze({
  summary: ',,',
  benchmark: 'benczmark',
  react: 'reakt',
  microsoft: 'mikrosoft',

  // Leading "c": a Polish voice reads it as "ts", so English c-words are the
  // most mangled. Note: matching is longest-key-first, so `cloudflare` wins over
  // `cloud`, and phrase keys win over their component words. (`code` is too short
  // to be a stem — it lives in ACRONYM_MAP — but `codex` still beats it because
  // the word pass cannot match a prefix.)
  claude: 'klod',
  // The `claude` stem alone left the "code" tail as raw English letters
  // ("klodcode"); the compound spells both halves. Stem mode, so Polish
  // endings still attach ("claudecodem" → "klod koudm").
  claudecode: 'klod koud',
  cursor: 'kersor',
  cache: 'kesz',
  cloud: 'klałd',
  cloudflare: 'klałdfler',
  commit: 'komit',
  codex: 'kodeks',
  copilot: 'kopajlot',
  checkout: 'czekałt',
  checkpoint: 'czekpojnt',
  compliance: 'komplajens',
  chrome: 'krołm',
  // Polish reads "ch" as /x/, so an unmapped "chunk" comes out as "hunk"
  chunk: 'czank',

  // Product / library names
  spacexai: 'spejs eks ej aj',
  openai: 'oupen ej aj',
  chatgpt: 'czat dżi pi ti',
  macbook: 'makbuk',
  android: 'endroid',
  windows: 'łindous',
  linux: 'linuks',
  github: 'git chab',
  gemini: 'dżemini',
  vercel: 'wersel',
  deepseek: 'dipsik',
  tailwind: 'tejlłind',
  // Same shape as `claudecode`: the `tailwind` stem left "css" unspoken.
  // The tail is the ACRONYM_MAP `css` value — word mode can never reach it
  // inside a compound, so it has to be spelled out here.
  tailwindcss: 'tejlłind si es es',
  typescript: 'tajpskrypt',
  javascript: 'dżawaskrypt',
  // The whole-word `gpu` acronym cannot match inside these compounds, so the
  // Web* names spell the acronym tail out themselves.
  webgpu: 'łeb dżi pi ju',
  webgl: 'łeb dżi el',
  usememo: 'juz memo',
  usecallback: 'juz kolbek',
  useeffect: 'juz efekt',
  usestate: 'juz stejt',
  useref: 'juz ref',
  compiler: 'kompajler',
  nvidia: 'en widia',
  nodejs: 'noud dżej es',
  turbopack: 'turbo pak',
  turbopacku: 'turbo paku',
  tubopacka: 'turbo pak',
  turbopackiem: 'turbo pakiem',
  trace: 'trejs',
  traców: 'trejsuf',
  tracem: 'trejsem',
  tracami: 'trejsemi',
  tracu: 'trejsu',
  tracach: 'trejsach',

  // Jargon
  githuba: 'git chaba',
  framework: 'frejmłerk',
  workflow: 'łerkflou',
  runtime: 'rantajm',
  feature: 'ficzer',
  review: 'rywju',
  build: 'bild',
  bundler: 'bandler',
  bundle: 'bandel',
  pipeline: 'pajplajn',
  deploy: 'diploj',
  release: 'rilis',
  update: 'apdejt',
  dashboard: 'daszbord',
  endpoint: 'endpojnt',
  merge: 'merdż',
  source: 'sors',
  gateway: 'gejtłej',
  provider: 'prowajder',
  layout: 'lejałt',
  payload: 'pejloud',
  storage: 'storidż',
  design: 'dizajn',
  sandbox: 'sendboks',
  exploit: 'eksplojt',
  reasoning: 'rizoning',
  'type-aware': 'tajp ełer',
  'key takeaways': 'kluczowe wnioski:',
  "pipeline'y": 'pajplajny',
  worker: 'łerker',

  // Multi-word phrases (safe: longest-key-first beats the component words;
  // the phrase also avoids the `face`→"facet" collision of a bare `face` stem)
  'pull request': 'pul rikłest',
  'open source': 'oupen sors',
  'hugging face': 'haging fejs',
})

/**
 * Whole-word acronym pronunciations. Unlike PRONUNCIATION_MAP (which is
 * stem-based and re-appends any trailing Polish inflection), these match ONLY as
 * a standalone word (optionally with a trailing plural "s"). That is required
 * for short acronyms that are a PREFIX of real words — e.g. `cli` starts
 * "client"/"click", `api` could start "apis" — where the stem map would corrupt
 * those words.
 *
 * Values are lowercase Polish phonetic spellings. Letter-by-letter acronyms are
 * spelled with spaces between the letter names (API → "ej pi aj"), never hyphens:
 * the voice then reads them calmly as separate letters instead of blurring them
 * into one word. Word-style acronyms (e.g. YAML → "jaml") are spelled as one token.
 * The Polish-phonetic spelling reads correctly on BOTH the Polish voices and the
 * multilingual voices (verified by ear: API/SDK came out right on William).
 */
export const ACRONYM_MAP: Readonly<Record<string, string>> = Object.freeze({
  cli: 'si el aj',
  api: 'ej pi aj',
  sdk: 'es di kej',
  gpu: 'dżi pi ju',
  cpu: 'si pi ju',
  ui: 'ju łaj,',
  // Word-style, one token, like `yaml` below.
  json: 'dżejson',
  // Word-style, one token: a Polish voice spells "YAML" letter by letter.
  yaml: 'jaml',
  ndjson: 'en di dżej es on',

  // Acronyms measured in the motyl corpus (uppercase uses ≥ 16). Letter names are
  // space-separated, like every letter-by-letter value in this preset.
  mcp: 'em si pi',
  glm: 'dżi el em',
  svg: 'es wi dżi',
  rag: 'er ej dżi',
  rsc: 'ar es si',
  // Keys are tried longest first, so the phrase key wins over the bare `vs` (versus).
  'vs code': 'wi es koud',
  vs: 'wersus',
  ssr: 'es es ar',
  seo: 'es i oł',
  jsx: 'dżej es eks',
  esm: 'i es em',
  cdn: 'si di en',
  agi: 'ej dżi aj',
  rl: 'ar el',
  cve: 'si wi i',
  kv: 'kej wi',
  wcag: 'dabl ju kag',
  lts: 'el ti es',
  wasm: 'łazem',
  mdn: 'em di en',
  tls: 'ti el es',
  rfc: 'ar ef si',
  orm: 'o ar em',
  ddd: 'di di di',
  lcp: 'el si pi',
  gsap: 'dżi sap',
  readme: 'ridmi',
  crud: 'krad',
  byok: 'bi łaj oł kej',
  s3: 'es tri',
  rtx: 'ar ti eks',
  e2e: 'end tu end',
  oidc: 'oł aj di si',
  htmx: 'ejcz ti em eks',
  stt: 'es ti ti',
  jit: 'dżit',
  cqrs: 'si kju ar es',
  sdlc: 'es di el si',
  mvp: 'em wi pi',
  sse: 'es es i',
  hmr: 'ejcz em ar',
  xss: 'eks es es',
  tdd: 'ti di di',
  csp: 'si es pi',
  ast: 'ej es ti',
  gguf: 'dżi dżi ju ef',
  vm: 'wi em',
  tpu: 'ti pi ju',
  pm: 'pi em',
  http: 'ejcz ti ti pi',
  // Own key: the `(s?)` plural group would read HTTPS as "ejcz ti ti pis".
  https: 'ejcz ti ti pi es',
  id: 'aj di',

  // More known acronyms (English letter names, Polish phonetic, space-separated)
  ux: 'ju eks',
  url: 'ju ar el',
  html: 'ejcz ti em el',
  css: 'si es es',
  xml: 'eks em el',
  sql: 'es kju el',
  llm: 'el el em',
  jwt: 'dżej dabl ju ti',
  npm: 'en pi em',
  ssh: 'es es ejcz',
  dns: 'di en es',
  tts: 'ti ti es',
  mr: 'em ar',
  // Stays here, and the word pass stays BEFORE the exact pass: the slash makes
  // this key unambiguous, and it must consume "CI/CD" whole before the bare
  // `CI`/`CD` exact keys could split it into "si aj/si di".
  'ci/cd': 'si aj si di',
  // `js` is not a Polish word, so case-insensitive word mode is safe; it also
  // reads the ".js" suffix of "Next.js"/"Vue.js" (the dot is a word boundary).
  // "JSON" stays `json`: the letter after "js" blocks the word end.
  js: 'dżej es',
  // Moved from PRONUNCIATION_MAP for the same reason as `ci/cd`: the word pass
  // runs before the stem pass, so as stems these were split by the bare `js`
  // key ("Node.dżej es") before they could match. Word mode, longest key first,
  // consumes them whole. Word mode drops the stem's Polish endings, which costs
  // nothing: all 590 corpus occurrences of "Node.js" are the bare word.
  'node.js': 'noud dżej es',
  'js/ts': 'dżej es / ti es',

  // Demoted from PRONUNCIATION_MAP: each is shorter than MIN_STEM_KEY_LENGTH, so
  // as a stem it swallowed every longer word it merely prefixed — `mac` turned
  // "machine" into "makhine", `code` turned "codebase" into "koudbase".
  // (`npm` was already here; its duplicate stem entry was deleted, not moved.)
  ai: 'ej aj',
  aws: 'ej dablju es',
  gpt: 'dżi pi ti',
  ios: 'aj os',
  mac: 'mak',
  macu: 'maku',
  code: 'koud',
  // Demoted later, for the same reason: as a stem, `macos` also matched the
  // Polish idiom "po macoszemu" (6 occurrences in the corpus) and turned it
  // into "po makoszemu". An identity entry cannot shield it — every key is
  // applied to the whole text independently, so `macos` matches again even
  // after a longer key rewrote the word to itself. Word mode is the fix, and
  // it costs nothing: all 170 corpus occurrences are the bare word.
  macos: 'makos',
  bug: 'bag',
  hook: 'huk',
  edge: 'edż',
  tldr: '..',
  vram: 'fał ram',

  // Inflections the demotion above lost. As a stem, `bug`/`hook`/`mac` also
  // caught every Polish ending; word mode matches the bare word only, so each
  // form that actually occurs in the corpus needs its own entry (base value +
  // the written ending). Only measured forms are listed — a speculative entry
  // is a future collision. The measurement is "which forms does the corpus
  // contain", not "do these guessed words occur": the first pass asked the
  // second question and so missed `hookiem`(4), `hooku`(3), `bugami`(3),
  // `Maca`(8) and `Maców`(3). English plurals ("bugs", "hooks") need nothing:
  // the `(s?)` group of the base key already covers them.
  bugi: 'bagi',
  bugów: 'bagów',
  buga: 'baga',
  bugiem: 'bagiem',
  bugami: 'bagami',
  // English adjective far more often than a Polish plural in this corpus, but
  // "bagi" is the right phonetic rendering of both readings.
  buggy: 'bagi',
  hooki: 'huki',
  hooków: 'huków',
  hooka: 'huka',
  hookiem: 'hukiem',
  hooku: 'huku',
  hookami: 'hukami',
  hookach: 'hukach',
  // Genitive/plural-genitive of `mac`. Written capitalised in the corpus, but
  // this map is case-insensitive, so the keys are lowercase like every other.
  // Checked for a homograph before adding: Polish "maca" (matzo, or "he
  // gropes") has zero occurrences here — all 8 "Maca" and 3 "Maców" are the
  // machine. Should a real "maca" ever appear, this entry is the collision.
  maca: 'maka',
  maców: 'maków',
  // Not a missing match — `edge` + the `(s?)` group already yields "edżs" — but
  // a phonetic fix: a Polish voice has no vowel to land on in "edżs", so the
  // explicit spelling gives it one.
  edges: 'edżes',
})

/**
 * A key shorter than this may not match as a stem — it would swallow longer
 * words. Stem matching re-appends any trailing letters, so a 3-letter key like
 * `ai` turns every word starting with "ai" into "ej aj" + the rest. Short keys
 * belong in ACRONYM_MAP (whole word) or EXACT_ACRONYMS (whole word, uppercase).
 */
export const MIN_STEM_KEY_LENGTH = 5

/**
 * Acronyms whose lowercase form is an ordinary word or means something else — matched
 * case-SENSITIVELY as a whole word, so only the uppercase spelling is replaced.
 * `ACRONYM_MAP` cannot hold these: it is case-insensitive, so it would also
 * rewrite the ordinary Polish word.
 *
 * Keys MUST be uppercase (a lowercase key could never match). Values are
 * lowercase Polish phonetic spellings, same as the other maps.
 */
export const EXACT_ACRONYMS: Readonly<Record<string, string>> = Object.freeze({
  // Each lowercase form is an ordinary Polish word: "mówię ci to", "cd. nastąpi",
  // "ide do domu", "pr" (rare), "qa". Uppercase dominates the corpus anyway
  // (CI 630/99, CD 157/15, IDE 245/16, PR 538/7, QA 83/9) and the error is
  // asymmetric: a missed lowercase "ci failed" merely reads as Polish, while a
  // case-insensitive `ci` would mispronounce every Polish "ci".
  CI: 'si aj',
  CD: 'si di',
  IDE: 'aj di i',
  PR: 'pi ar',
  QA: 'kju ej',
  // Same asymmetry: "swe" (swe dzieci), "ml" (millilitre), "mit" (myth) and the
  // English pronoun "it" are ordinary words; lowercase "dx" occurs mostly in
  // identifiers and code-like contexts, so only the uppercase "DX" is the acronym;
  // lowercase "v8" is a version ("React Router v8"), only "V8" is the engine.
  SWE: 'es dabl ju i',
  ML: 'em el',
  MIT: 'em aj ti',
  IT: 'aj ti',
  DX: 'di eks',
  V8: 'wi ejt',
})

export interface PronunciationPass {
  readonly mode: PronunciationMatchMode
  readonly map: Readonly<Record<string, string>>
}

/**
 * The pl preset's passes, in the order `applyPronunciation` runs the modes.
 *
 * `exact` MUST stay last: the `ci/cd` key (word mode) has to consume "CI/CD"
 * whole before a bare `CI` exact key could ever split it into "si aj/CD".
 */
export const PRONUNCIATION_PASSES: readonly PronunciationPass[] = Object.freeze([
  { mode: 'word', map: ACRONYM_MAP },
  { mode: 'stem', map: PRONUNCIATION_MAP },
  { mode: 'exact', map: EXACT_ACRONYMS },
])

/** The shipped `pl` Pronunciation map: every entry above, tagged with its match mode. */
export const plPreset: PronunciationMap = Object.freeze(
  Object.fromEntries(
    PRONUNCIATION_PASSES.flatMap(({ mode, map }) =>
      Object.entries(map).map(([key, say]) => [key, { say, match: mode }] as const)
    )
  )
)
