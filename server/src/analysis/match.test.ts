import { describe, it, expect } from 'vitest';
import { matchNotes } from './match.js';
import type { Note } from '../notes.js';

function note(id: string, triggers: string[], severity: Note['severity']): Note {
  return { id, title: id, triggers, words: [], contrasts: [], severity, markdown: '', file: `${id}.md` };
}

describe('matchNotes', () => {
  const notes = [
    note('info-note', ['flap-t'], 'info'),
    note('l-vs-n', ['phoneme:l', 'phoneme:n'], 'confirmed'),
    note('watch-note', ['phoneme:l'], 'watch'),
  ];

  it('returns hits with matched tags, severity order', () => {
    const hits = matchNotes(['phoneme:k', 'phoneme:l', 'clear-l'], notes);
    expect(hits.map((h) => h.note.id)).toEqual(['l-vs-n', 'watch-note']);
    expect(hits[0].matched).toEqual(['phoneme:l']);
  });

  it('no tags → no hits', () => {
    expect(matchNotes([], notes)).toEqual([]);
  });
});
