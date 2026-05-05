const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Explicit polyfill map for Node.js built-ins used by gramjs (telegram package).
// resolveRequest intercepts module resolution before Metro gives up, unlike
// extraNodeModules which can be bypassed by Metro's built-in resolver for
// known Node core modules.
const POLYFILLS = {
  crypto: require.resolve('crypto-browserify'),
  stream: require.resolve('stream-browserify'),
  path: require.resolve('path-browserify'),
  os: require.resolve('os-browserify/browser'),
  assert: require.resolve('assert/'),
  constants: require.resolve('constants-browserify'),
  vm: require.resolve('vm-browserify'),
  buffer: require.resolve('buffer/'),
  process: require.resolve('process/'),
  events: require.resolve('events/'),
  util: require.resolve('util/'),
};

// Modules with no browser equivalent — return an empty module stub
const EMPTY_MODULES = new Set(['fs', 'net', 'tls', 'child_process', 'dns']);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (POLYFILLS[moduleName]) {
    return { filePath: POLYFILLS[moduleName], type: 'sourceFile' };
  }
  if (EMPTY_MODULES.has(moduleName)) {
    return { filePath: require.resolve('./emptyModule.js'), type: 'sourceFile' };
  }
  // Fall through to default Metro resolution
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
