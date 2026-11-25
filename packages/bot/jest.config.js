module.exports = {
  rootDir: __dirname,
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleDirectories: ['node_modules'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 10000,
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
