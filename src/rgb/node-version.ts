// Imported first by the RGB wallet so a wrong Node fails with a clear message
// before rgb-lib's native binding is loaded (ESM evaluates imports in order).

const major = Number(process.versions.node.split('.')[0])
if (major >= 25) throw new Error(`RGB wallets need Node 22 or 24: rgb-lib's native binding does not build on Node ${process.versions.node}. See .nvmrc and the README.`)

export {}
