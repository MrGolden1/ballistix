/** Longest player name, in characters. */
export const MAX_NAME = 14;

/**
 * Cleans a player name. Names of other players arrive over the network, so everything is stripped that
 * could break the page or make text misleading: markup characters, control and invisible characters,
 * right-to-left overrides. What is left is trimmed, single-spaced and cut to MAX_NAME characters.
 */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(text).slice(0, MAX_NAME).join('');
}

/** For text that is put into innerHTML. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** First letter of a name, for the round avatar. */
export function initial(name: string): string {
  return (Array.from(name)[0] ?? '?').toUpperCase();
}
