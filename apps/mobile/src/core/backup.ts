// The backup check: before a new wallet is saved, the user types back three of
// their words, picked at random, so a skipped or mis-copied backup is caught
// while the words are still on screen.

export const CHECK_COUNT = 3

/** Three distinct word positions (0-based), in ascending order. */
export function pickCheckPositions(wordCount: number, random: () => number = Math.random): number[] {
  if (!Number.isInteger(wordCount) || wordCount < CHECK_COUNT) throw new Error('not enough words')
  const picked = new Set<number>()
  while (picked.size < CHECK_COUNT) picked.add(Math.min(wordCount - 1, Math.floor(random() * wordCount)))
  return [...picked].sort((a, b) => a - b)
}

export function splitWords(phrase: string): string[] {
  return phrase.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/** True when every typed answer matches the word at its position. */
export function verifyBackup(words: readonly string[], positions: readonly number[], answers: readonly string[]): boolean {
  if (positions.length !== CHECK_COUNT || answers.length !== CHECK_COUNT) return false
  return positions.every((p, i) => p >= 0 && p < words.length && answers[i].trim().toLowerCase() === words[p])
}

/** Ordinal for the prompt: 0 -> "1st", 1 -> "2nd". */
export function ordinal(i: number): string {
  const n = i + 1
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${s}`
}
