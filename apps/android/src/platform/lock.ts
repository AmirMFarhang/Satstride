// Approving, paying and sharing need the phone's own lock first: biometrics or
// the screen-lock PIN, pattern or password. A phone with no lock can't approve.

import * as LocalAuthentication from 'expo-local-authentication'
import { PHONE_ONLY } from '../core/strings.js'

export type LockResult = { ok: true } | { ok: false; message: string }
export type DeviceLock = (prompt: string) => Promise<LockResult>

export const deviceLock: DeviceLock = async (prompt) => {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync()
    if (level === LocalAuthentication.SecurityLevel.NONE) return { ok: false, message: PHONE_ONLY.lockNeeded }
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, cancelLabel: 'Cancel', disableDeviceFallback: false })
    return r.success ? { ok: true } : { ok: false, message: PHONE_ONLY.lockCancelled }
  } catch {
    return { ok: false, message: PHONE_ONLY.lockCancelled }
  }
}
