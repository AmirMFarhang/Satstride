// Scans the dashboard's pairing QR with the camera (expo-camera, ML Kit on Android).
// An aiming frame, a torch for a dim room, the camera's own errors on screen, and,
// if nothing is read for a while, the two other ways to pair.

import { CameraView, useCameraPermissions } from 'expo-camera'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { PHONE_ONLY } from '../core/strings.js'
import { Btn, P } from './kit'
import type { ScannerProps } from './Phone'

const SLOW_MS = 15_000

export function Scanner({ onCode, onClose }: ScannerProps) {
  const [permission, request] = useCameraPermissions()
  const [torch, setTorch] = useState(false)
  const [slow, setSlow] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [other, setOther] = useState(false)
  const done = useRef(false)

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(t)
  }, [])

  if (!permission) return null
  if (!permission.granted) {
    return (
      <View style={st.pad}>
        <P>{permission.canAskAgain ? PHONE_ONLY.cameraWhy : PHONE_ONLY.cameraDenied}</P>
        {permission.canAskAgain ? <Btn testID="allow-camera" label={PHONE_ONLY.allowCamera} onPress={() => void request()} /> : null}
        <Btn kind="second" label={PHONE_ONLY.back} onPress={onClose} />
      </View>
    )
  }
  return (
    <View style={st.fill}>
      {failed ? (
        <View style={st.pad}><P>{`${PHONE_ONLY.cameraFailed} ${failed}`}</P></View>
      ) : (
        <View style={st.fill}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={torch}
            autofocus="on"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onMountError={(e) => setFailed(e.message)}
            onBarcodeScanned={({ data }) => {
              if (done.current) return
              if (!data.startsWith('passbook://pair')) { setOther(true); return }
              done.current = true
              onCode(data)
            }}
          />
          <View pointerEvents="none" style={st.overlay}>
            <View style={st.frame} />
            <Text style={st.hint}>{other ? PHONE_ONLY.notPairing : PHONE_ONLY.aim}</Text>
          </View>
        </View>
      )}
      <View style={st.bar}>
        {slow || failed ? <P small>{PHONE_ONLY.scanSlow}</P> : null}
        <View style={st.row}>
          <Btn kind="second" label={torch ? PHONE_ONLY.torchOff : PHONE_ONLY.torchOn} onPress={() => setTorch(!torch)} disabled={!!failed} />
          <Btn kind="second" label={PHONE_ONLY.back} onPress={onClose} />
        </View>
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  fill: { flex: 1 },
  pad: { padding: 16, gap: 12 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 16 },
  frame: { width: 260, height: 260, borderWidth: 3, borderColor: '#ffffff', borderRadius: 16 },
  hint: { color: '#ffffff', fontSize: 15, fontWeight: '600', textAlign: 'center', paddingHorizontal: 24, textShadowColor: '#000000', textShadowRadius: 4 },
  bar: { padding: 16, gap: 8 },
  row: { flexDirection: 'row', gap: 8 },
})
