module.exports = {
  preset: 'jest-expo',
  // The first render lazily transforms React Native components in each worker.
  // Allow startup plus the polling tests' separate 10s waits on shared CI CPUs.
  maxWorkers: 2,
  testTimeout: 30_000,
  // src/core's .js imports name .ts files (see metro.config.js)
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|react-navigation|@react-navigation/.*|@noble/.*)'],
  setupFiles: ['<rootDir>/__tests__/setup.ts'],
  testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)'],
}
