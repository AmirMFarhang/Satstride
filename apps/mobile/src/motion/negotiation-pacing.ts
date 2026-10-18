// A display clock only. The signed protocol continues independently of this queue.
export const MESSAGE_DWELL_MS = 1200
export interface NegotiationFrame { id: string; shown: number; nextAt: number; ready: boolean }
export function negotiationFrame(previous: NegotiationFrame | null, id: string, count: number, now: number): NegotiationFrame {
  if (!previous || previous.id !== id) return { id, shown: Math.min(1, count), nextAt: now + MESSAGE_DWELL_MS, ready: count === 0 }
  if (count < previous.shown) return { id, shown: count, nextAt: now + MESSAGE_DWELL_MS, ready: count === 0 }
  if (previous.shown < count && now >= previous.nextAt) return { id, shown: previous.shown + 1, nextAt: now + MESSAGE_DWELL_MS, ready: false }
  const ready = previous.shown === count && now >= previous.nextAt
  return previous.ready === ready ? previous : { ...previous, ready }
}
