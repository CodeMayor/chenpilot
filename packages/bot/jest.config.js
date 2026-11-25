const path = require('path');

const workspaceRoot = path.resolve(__dirname, '../..');

module.exports = {
  rootDir: workspaceRoot,
  roots: ['<rootDir>/packages/bot/src'],
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleDirectories: ['node_modules', 'packages/bot/node_modules'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 10000,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/packages/bot/tsconfig.json',
        diagnostics: false,
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
