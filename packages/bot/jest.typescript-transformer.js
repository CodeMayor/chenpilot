const { createTransformer } = require('ts-jest');

module.exports = createTransformer({
  tsconfig: require('path').resolve(__dirname, 'tsconfig.json'),
  diagnostics: false,
});
