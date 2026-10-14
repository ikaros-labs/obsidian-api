import { describe, expect, it } from 'vitest';
import { snippet } from '../src/search/index.js';
import { containsPhrase, parseQuery, QueryError } from '../src/search/query.js';
import { stem, stemEnglish, stemRussian, tokenize, words } from '../src/search/tokenize.js';

describe('tokenize', () => {
  it('splits mixed Cyrillic/Latin text into lowercased words', () => {
    expect(words('PCB-плата для KiCad 10, ёлка!')).toEqual(['pcb', 'плата', 'для', 'kicad', '10', 'елка']);
  });

  it('drops stopwords and single letters but keeps numbers', () => {
    expect(tokenize('The notes и заметки в 3 a')).toEqual(['note', 'заметк', '3']);
  });

  it('folds ё so both spellings match', () => {
    expect(tokenize('Ёжик')).toEqual(tokenize('ежик'));
  });

  it('normalises composed and decomposed forms', () => {
    expect(tokenize('й'.normalize('NFD') + 'од')).toEqual(tokenize('йод'));
  });
});

describe('stemRussian (Snowball)', () => {
  it.each([
    ['книги', 'книг'],
    ['книгами', 'книг'],
    ['красивая', 'красив'],
    ['красивые', 'красив'],
    ['заметки', 'заметк'],
    ['заметок', 'заметок'],
    ['читать', 'чита'],
    ['читаю', 'чита'],
    ['программирование', 'программирован'],
    ['вдохновение', 'вдохновен'],
    ['одновременно', 'одновремен'],
    ['радость', 'радост'],
    ['величайший', 'величайш'],
  ])('%s → %s', (word, expected) => {
    expect(stemRussian(word)).toBe(expected);
  });

  it('maps inflections of a noun to one stem', () => {
    const forms = ['принтер', 'принтера', 'принтеру', 'принтером', 'принтере', 'принтеры', 'принтеров'];
    expect(new Set(forms.map(stemRussian))).toEqual(new Set(['принтер']));
  });

  it('leaves short words alone', () => {
    expect(stemRussian('я')).toBe('я');
    expect(stemRussian('сон')).toBe('сон');
  });
});

describe('stemEnglish', () => {
  it.each([
    ['notes', 'note'],
    ['libraries', 'library'],
    ['classes', 'class'],
    ['printing', 'print'],
    ['printed', 'print'],
    ['running', 'run'],
    ['status', 'status'],
    ['analysis', 'analysis'],
    ['bus', 'bus'],
    ['ai', 'ai'],
  ])('%s → %s', (word, expected) => {
    expect(stemEnglish(word)).toBe(expected);
  });

  it('only stems pure Latin words', () => {
    expect(stem('kicad10')).toBe('kicad10');
    expect(stem('café')).toBe('café');
  });
});

describe('snippet', () => {
  it('returns the first line with a match', () => {
    expect(snippet('# Title\n\nnothing\nall about printers here\n', new Set(['printer']))).toBe('all about printers here');
  });

  it('falls back to the first non-empty line', () => {
    expect(snippet('\n\nfirst line\nsecond', new Set(['zzz']))).toBe('first line');
  });

  it('centres long lines on the match', () => {
    const long = `${'lorem ipsum '.repeat(30)}needle ${'dolor sit '.repeat(30)}`;
    const s = snippet(long, new Set(['needle']));
    expect(s).toContain('needle');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(162);
  });
});

describe('parseQuery', () => {
  it('parses words, prefixes, phrases and exclusions', () => {
    expect(parseQuery('Printers "reading list" -draft pri* -"old stuff" -kicad*')).toEqual([
      { kind: 'term', negate: false, text: 'printers', term: 'printer' },
      { kind: 'phrase', negate: false, text: 'reading list', terms: ['read', 'list'] },
      { kind: 'term', negate: true, text: 'draft', term: 'draft' },
      { kind: 'prefix', negate: false, text: 'pri*', prefixes: ['pri'] },
      { kind: 'phrase', negate: true, text: 'old stuff', terms: ['old', 'stuff'] },
      { kind: 'prefix', negate: true, text: 'kicad*', prefixes: ['kicad'] },
    ]);
  });

  it('treats hyphenated words as phrases and drops stopwords inside phrases', () => {
    expect(parseQuery('pcb-плата')).toEqual([{ kind: 'phrase', negate: false, text: 'pcb-плата', terms: ['pcb', 'плат'] }]);
    expect(parseQuery('"the list"')).toEqual([{ kind: 'term', negate: false, text: 'the list', term: 'list' }]);
  });

  it('stems prefixes as well', () => {
    expect(parseQuery('принтеры*')[0]).toMatchObject({ kind: 'prefix', prefixes: ['принтеры', 'принтер'] });
  });

  it('tolerates an unclosed quote, stray dashes and duplicates', () => {
    expect(parseQuery('"open phrase')).toMatchObject([{ kind: 'phrase', terms: ['open', 'phrase'] }]);
    expect(parseQuery('a - note note')).toEqual([{ kind: 'term', negate: false, text: 'note', term: 'note' }]);
    expect(parseQuery('и в на')).toEqual([]);
  });

  it('rejects queries that only exclude', () => {
    expect(() => parseQuery('-draft -"old stuff"')).toThrow(QueryError);
  });
});

describe('containsPhrase', () => {
  it('finds consecutive terms only', () => {
    expect(containsPhrase(['a', 'b', 'c'], ['b', 'c'])).toBe(true);
    expect(containsPhrase(['a', 'b', '', 'c'], ['b', 'c'])).toBe(false);
    expect(containsPhrase(['a', 'c', 'b'], ['b', 'c'])).toBe(false);
    expect(containsPhrase(['a'], [])).toBe(false);
  });
});
