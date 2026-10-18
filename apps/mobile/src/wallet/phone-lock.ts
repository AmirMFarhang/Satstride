// The phone's own lock (biometrics or the device PIN/pattern) gates every step that
// touches the seed: opening the wallet, saving a new one, showing the words and
// signing. Without a screen lock on the phone the wallet refuses to hold a seed.
import * as LocalAuthentication from 'expo-local-authentication'

export type LockResult = { ok: true } | { ok: false; reason: string }

export async function phoneLockAvailable(): Promise<boolean> {
  const level = await LocalAuthentication.getEnrolledLevelAsync()
  return level !== LocalAuthentication.SecurityLevel.NONE
}

export async function requirePhoneLock(promptMessage: string): Promise<LockResult> {
  if (!(await phoneLockAvailable())) {
    return { ok: false, reason: 'Set a screen lock (PIN, pattern or fingerprint) on this phone first. The wallet keeps its seed behind it.' }
  }
  const r = await LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel: 'Cancel', disableDeviceFallback: false })
  if (r.success) return { ok: true }
  return { ok: false, reason: r.error === 'user_cancel' || r.error === 'system_cancel' ? 'Cancelled.' : `Phone lock failed (${r.error}).` }
}
