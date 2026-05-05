// index.js - Entry point
// CRITICAL: Both must use require() — NOT import.
// ES import declarations are hoisted by Babel ABOVE require() calls,
// which would load the entire module graph before polyfills are set up.
// GramJS depends on Buffer, crypto.getRandomValues, and localStorage
// being global BEFORE any module evaluates.
require('./polyfills');
require('expo/AppEntry');
