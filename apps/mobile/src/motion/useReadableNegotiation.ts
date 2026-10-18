import { useEffect, useState } from 'react'
import { negotiationFrame } from './negotiation-pacing'

export function useReadableNegotiation(id: string, count: number) {
  const [frame, setFrame] = useState(() => negotiationFrame(null, id, count, Date.now()))
  useEffect(() => { setFrame((p) => negotiationFrame(p, id, count, Date.now())) }, [id, count])
  useEffect(() => {
    if (!count || (frame.id === id && frame.ready && frame.shown === count)) return
    const timer = setTimeout(() => setFrame((p) => negotiationFrame(p, id, count, Date.now())), Math.max(1, frame.nextAt - Date.now()))
    return () => clearTimeout(timer)
  }, [frame, id, count])
  return frame.id === id ? frame : negotiationFrame(null, id, count, Date.now())
}
