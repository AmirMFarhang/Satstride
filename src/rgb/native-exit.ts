// Imported by every module that loads rgb-lib's native binding, so a process
// that used an RGB wallet does not crash on its way out.
//
// The binding is a SWIG V8 addon. It frees the JS wrapper of each native handle
// (wallet, online, invoice) in a V8 weak callback that calls
// v8::Isolate::GetCurrent(). If the process exits while an incremental marking
// cycle is running, node finishes that cycle while it tears the isolate down
// (~IsolateData -> CppHeap::DetachIsolate), when no isolate is current. A
// wrapper found dead in that cycle, such as a closed wallet's, then dereferences
// NULL and the process ends with SIGSEGV after its work is done (seen at the exit
// of test/regtest/governance.test.ts in about 1 run in 10).
//
// A full collection at the 'exit' event runs those callbacks while the isolate
// is still current and leaves no marking cycle for the teardown.

import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

function fullCollection(): () => void {
  const exposed = (globalThis as { gc?: unknown }).gc
  if (typeof exposed === 'function') return exposed as () => void
  // only the context created here gets gc(); the flag is restored at once
  setFlagsFromString('--expose-gc')
  try {
    return runInNewContext('gc') as () => void
  } finally {
    setFlagsFromString('--no-expose-gc')
  }
}

const collect = fullCollection()
process.once('exit', () => collect())

export {}
