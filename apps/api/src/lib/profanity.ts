/**
 * Lightweight profanity check for public Q&A (FR-VID-13). Flagged posts still
 * go to a human moderator; nothing is published without moderation.
 */
const WORDS = [
  'fuck', 'shit', 'bitch', 'bastard', 'asshole', 'dick', 'cunt', 'slut', 'whore', 'motherfucker', 'bullshit', 'damn', 'crap', 'piss',
  'idiot', 'stupid', 'retard', 'nigger', 'fag', 'porn', 'sex',
];
const PATTERN = new RegExp(`\\b(${WORDS.map((w) => w.replace(/[aeiou]/g, '[$&*@0-9]')).join('|')})\\w*`, 'i');

export function containsProfanity(text: string): boolean {
  const normalised = text.replace(/(.)\1{2,}/g, '$1$1').replace(/[_.\-]/g, '');
  return PATTERN.test(normalised);
}
