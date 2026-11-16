/**
 * Tokeniser for mixed Russian/English notes: Unicode letter/digit runs, lowercased, `ё` folded to
 * `е`, stopwords dropped, then stemmed (Snowball Russian for Cyrillic words, a light suffix
 * stripper for Latin ones). Documents and queries go through the same function, so the stemmers
 * only need to be consistent, not linguistically perfect.
 */

const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const LATIN_ONLY_RE = /^[a-z]+$/;
const MAX_TOKEN = 40;

const STOPWORDS = new Set(
  (
    'a an and are as at be but by for from has have i if in into is it its of on or that the their them then ' +
    'there these they this to was we were what when which who will with you your ' +
    'а без бы был была были было в вам вас весь во вот все всё вы да для до его ее её если есть еще ещё же за ' +
    'и из или им их к как ко когда кто ли либо мне мы на над не нет ни но ну о об от по под при про с со так ' +
    'также там то тоже только у уж уже чем что чтобы эта эти это я'
  )
    .split(' ')
    .map((w) => w.replace(/ё/g, 'е')),
);

/** Splits text into normalised words, before stopwords and stemming. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFC').toLowerCase().matchAll(WORD_RE)) {
    const w = m[0].replace(/ё/g, 'е');
    if (w.length <= MAX_TOKEN) out.push(w);
  }
  return out;
}

/** False for stopwords and single letters, which are never indexed. */
export const isIndexable = (w: string) => !STOPWORDS.has(w) && (w.length >= 2 || /\d/.test(w));

export function stem(word: string): string {
  if (CYRILLIC_RE.test(word)) return stemRussian(word);
  if (LATIN_ONLY_RE.test(word)) return stemEnglish(word);
  return word;
}

export const isStopword = (w: string) => STOPWORDS.has(w);

/** Index/query terms for `text`, in order (duplicates kept, so callers can count frequencies). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (isIndexable(w)) out.push(stem(w));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// English: plural and -ing/-ed stripping. Enough to match "notes"/"note", "printing"/"print".

const VOWEL_EN = /[aeiouy]/;

export function stemEnglish(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const suffix of ['ing', 'ed']) {
    if (!w.endsWith(suffix)) continue;
    const base = w.slice(0, -suffix.length);
    if (base.length < 3 || !VOWEL_EN.test(base)) continue;
    w = /([^aeiouylsz])\1$/.test(base) ? base.slice(0, -1) : base;
    break;
  }
  return w;
}

// ---------------------------------------------------------------------------------------------
// Russian: the Snowball algorithm (https://snowballstem.org/algorithms/russian/stemmer.html).

const VOWEL_RU = 'аеиоуыэюя';
const isVowel = (c: string | undefined) => c !== undefined && VOWEL_RU.includes(c);

/** Suffix group; `afterAYa` endings must follow а or я (which stays). */
type Group = { suffixes: string[]; afterAYa?: boolean };

const PERFECTIVE_GERUND: Group[] = [
  { suffixes: ['в', 'вши', 'вшись'], afterAYa: true },
  { suffixes: ['ив', 'ивши', 'ившись', 'ыв', 'ывши', 'ывшись'] },
];
const ADJECTIVE: Group[] = [
  {
    suffixes: 'ее ие ые ое ими ыми ей ий ый ой ем им ым ом его ого ему ому их ых ую юю ая яя ою ею'.split(' '),
  },
];
const PARTICIPLE: Group[] = [
  { suffixes: ['ем', 'нн', 'вш', 'ющ', 'щ'], afterAYa: true },
  { suffixes: ['ивш', 'ывш', 'ующ'] },
];
const REFLEXIVE: Group[] = [{ suffixes: ['ся', 'сь'] }];
const VERB: Group[] = [
  { suffixes: 'ла на ете йте ли й л ем н ло но ет ют ны ть ешь нно'.split(' '), afterAYa: true },
  {
    suffixes: 'ила ыла ена ейте уйте ите или ыли ей уй ил ыл им ым ен ило ыло ено ят ует уют ит ыт ены ить ыть ишь ую ю'.split(' '),
  },
];
const NOUN: Group[] = [
  {
    suffixes: 'а ев ов ие ье е иями ями ами еи ии и ией ей ой ий й иям ям ием ем ам ом о у ах иях ях ы ь ию ью ю ия ья я'.split(' '),
  },
];
const DERIVATIONAL: Group[] = [{ suffixes: ['ост', 'ость'] }];
const SUPERLATIVE: Group[] = [{ suffixes: ['ейш', 'ейше'] }];

/**
 * Snowball `among`: finds the longest suffix of `w` (lying at or after `start`) from all groups,
 * then checks that group's condition. Returns the word without it, or null when nothing applies.
 */
function strip(w: string, start: number, groups: Group[]): string | null {
  let best: { s: string; g: Group } | null = null;
  for (const g of groups) {
    for (const s of g.suffixes) {
      if (w.length - s.length >= start && w.endsWith(s) && (!best || s.length > best.s.length)) best = { s, g };
    }
  }
  if (!best) return null;
  const cut = w.length - best.s.length;
  if (best.g.afterAYa) {
    const prev = w[cut - 1];
    if (cut - 1 < start || (prev !== 'а' && prev !== 'я')) return null;
  }
  return w.slice(0, cut);
}

/** Start of the region after the first vowel-then-consonant pair, searching from `from`. */
function regionAfter(w: string, from: number): number {
  for (let i = from + 1; i < w.length; i++) if (!isVowel(w[i]) && isVowel(w[i - 1])) return i + 1;
  return w.length;
}

export function stemRussian(word: string): string {
  let w = word.replace(/ё/g, 'е');
  let rv = w.length;
  for (let i = 0; i < w.length; i++) {
    if (isVowel(w[i])) {
      rv = i + 1;
      break;
    }
  }
  const r1 = regionAfter(w, 0);
  const r2 = regionAfter(w, r1);

  // Step 1
  const gerund = strip(w, rv, PERFECTIVE_GERUND);
  if (gerund !== null) {
    w = gerund;
  } else {
    w = strip(w, rv, REFLEXIVE) ?? w;
    const adj = strip(w, rv, ADJECTIVE);
    if (adj !== null) {
      w = strip(adj, rv, PARTICIPLE) ?? adj;
    } else {
      w = strip(w, rv, VERB) ?? strip(w, rv, NOUN) ?? w;
    }
  }
  // Step 2
  if (w.length > rv && w.endsWith('и')) w = w.slice(0, -1);
  // Step 3
  w = strip(w, Math.max(r2, rv), DERIVATIONAL) ?? w;
  // Step 4
  if (w.length - 2 >= rv && w.endsWith('нн')) {
    w = w.slice(0, -1);
  } else {
    const sup = strip(w, rv, SUPERLATIVE);
    if (sup !== null) {
      w = sup;
      if (w.length - 2 >= rv && w.endsWith('нн')) w = w.slice(0, -1);
    } else if (w.length > rv && w.endsWith('ь')) {
      w = w.slice(0, -1);
    }
  }
  return w;
}
