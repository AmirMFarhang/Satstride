module.exports = {
  preset: 'jest-expo',
  // src/core's .js imports name .ts files (see metro.config.js)
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transformIgnorePatterns: ['node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|react-navigation|@react-navigation/.*|@noble/.*)'],
  setupFiles: ['<rootDir>/__tests__/setup.ts'],
  testMatch: ['<rootDir>/__tests__/**/*.test.ts?(x)'],
}
