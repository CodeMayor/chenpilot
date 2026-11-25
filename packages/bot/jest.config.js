const path = require('path');
const tsJest = require.resolve('ts-jest', {
  paths: [__dirname, path.resolve(__dirname, '../..')],
});

module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      tsJest,
      { tsconfig: '<rootDir>/tsconfig.json', diagnostics: false },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 10000,
};
