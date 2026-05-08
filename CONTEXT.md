# Telegram Drive Mobile — Debug Context for LLM Handoff

> **Last updated:** 2026-05-08
> **Status:** OTP auth flow crashes on Android (native crash, not JS error)
> **Repo:** https://github.com/0xJhinkz/Telegram-Drive-Mobile
> **Fork:** https://github.com/R1ghTsS/Telegram-Drive-Mobile
> **Branch:** `fix/gramjs-auth-comprehensive`
> **Local build workspace:** `C:\td\mobile-app` (short path to avoid Windows MAX_PATH)

---

## 1. What This App Does

React Native (Expo) Android app that uses Telegram as cloud storage. Users authenticate with their Telegram account via OTP, then browse/upload/download files stored in Telegram chats.

**Stack:** React Native 0.76.9 + Expo SDK 52 + Hermes engine + `gramjs` (telegram npm package) for Telegram MTProto API.

---

## 2. The Bug

**When the user taps "Send Code" (OTP request), the app crashes with an Android system-level error — NOT a JS exception.** The crash happens during the MTProto auth key handshake that GramJS performs when connecting to Telegram servers.

Screenshot evidence: Android System notification "App Error — It was detected that the Telegram Drive app crashed due to its own issues."

---

## 3. Root Cause Analysis (Completed)

### The Crypto Chain

GramJS has TWO crypto code paths:

```
Path A (Node.js style — WORKS):
  Helpers.js → CryptoFile.js → require("crypto") → crypto-browserify (via metro.config.js)
  Used for: sha1(), sha256(), generateRandomBytes()

Path B (Web Crypto API — CRASHES):
  telegram/crypto/crypto.js → self.crypto.subtle.digest("SHA-256", data)
  Used for: Hash.digest(), pbkdf2Sync()
  THIS PATH CRASHES because Hermes has NO crypto.subtle
```

### Who calls what during sendCode()

```
gramClient.init() → client.connect() → MTProto handshake (Authenticator.js)
  → Helpers.sha256()  → CryptoFile → crypto-browserify  ✅ WORKS
  → Helpers.sha1()    → CryptoFile → crypto-browserify  ✅ WORKS
```

But `CryptoFile.js` does `require("crypto")` → `crypto-browserify`.
And `crypto-browserify` exports `createHash` which returns sync Hash objects.

HOWEVER: `telegram/crypto/crypto.js` ALSO exports `createHash`, `Hash`, `randomBytes`
and is required by `telegram/crypto/AuthKey.js`, `telegram/crypto/IGE.js`, etc.

### Key Files in GramJS

| File | Role | Crypto Source |
|------|------|---------------|
| `telegram/CryptoFile.js` | Main crypto abstraction | `require("crypto")` → crypto-browserify |
| `telegram/crypto/crypto.js` | Browser crypto impl | `self.crypto.subtle` (Web Crypto API) — **BROKEN** |
| `telegram/Helpers.js` | Utility functions | Uses `CryptoFile.js` |
| `telegram/network/Authenticator.js` | MTProto handshake | Uses `Helpers.js` |
| `telegram/crypto/AuthKey.js` | Auth key generation | Imports from `./crypto` |
| `telegram/platform.js` | Env detection | `isNode = true` in RN (no `window`) |

### Platform Detection Issue

`telegram/platform.js`:
```js
exports.isBrowser = typeof window !== "undefined";  // false in RN
exports.isNode = !exports.isBrowser;                // true in RN — WRONG
```

GramJS thinks it's running in Node.js. With `useWSS: true` it uses WebSocket, but some internal code paths may still try Node-specific things.

---

## 4. What We've Tried (All PRs Merged to upstream)

| PR | Fix | Result |
|----|-----|--------|
| #7 | Kotlin/Compose version mismatch + splash drawable | ✅ Build fixed |
| #9 | `useWSS: true` for WebSocket transport | ✅ Partial — still crashes |
| #10 | Polyfill hoisting (import→require) + missing globals | ✅ Partial — still crashes |
| #11 | `react-native-quick-crypto` for `crypto.subtle` | ❌ `react-native-nitro-modules` incompatible with RN 0.76.9 |
| #12 | `subtleCryptoShim.js` (pure JS crypto.subtle) | ❌ Native Hermes crash |
| #13 | Metro-level patch of `telegram/crypto/crypto.js` | ⏳ **PENDING TEST** — just created |

### PR #13 Approach (Latest — needs testing)

Instead of polyfilling `crypto.subtle`, we **replace the entire `telegram/crypto/crypto.js` file** at the Metro bundler level:

1. `patches/gramjs-crypto.js` — drop-in replacement that uses `crypto-browserify.createHash()` (sync) instead of `self.crypto.subtle.digest()` (async Web Crypto)
2. `metro.config.js` — resolver intercepts resolution of `telegram/crypto/crypto.js` and redirects to the patch

**This completely eliminates any dependency on Web Crypto API.**

---

## 5. Key Files in the App

```
mobile-app/
├── index.js              # Entry point — uses require() not import (prevents hoisting)
├── polyfills.js          # Global polyfills: Buffer, process, crypto.getRandomValues, localStorage, self, navigator
├── metro.config.js       # Node→browserify shims + GramJS crypto patch redirect
├── patches/
│   └── gramjs-crypto.js  # Drop-in replacement for telegram/crypto/crypto.js
├── subtleCryptoShim.js   # OLD — no longer used (caused native crash)
├── emptyModule.js        # Empty stub for fs, net, tls, etc.
├── services/
│   ├── gramClient.js     # GramJS client wrapper (lazy-loaded)
│   └── telegramService.js # Auth flow: requestLoginCode(), signInWithCode()
├── android/
│   └── build.gradle      # Needs Kotlin suppress patch (see Build section)
└── app.config.js         # Expo config
```

---

## 6. Build Instructions

### Prerequisites
- Node.js, JDK 17, Android SDK
- Short workspace path to avoid Windows MAX_PATH (we use `C:\td\mobile-app`)
- Gradle home at short path too (`C:\g`)

### Build Steps
```bash
cd mobile-app
npm install --legacy-peer-deps
npx expo prebuild --platform android --clean

# CRITICAL: Patch build.gradle after prebuild (prebuild regenerates android/)
# Add to end of android/build.gradle:
```

```groovy
gradle.projectsEvaluated {
    subprojects {
        tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompile).configureEach {
            compilerOptions {
                freeCompilerArgs.addAll([
                    "-P",
                    "plugin:androidx.compose.compiler.plugins.kotlin:suppressKotlinVersionCompatibilityCheck=1.9.25"
                ])
            }
        }
    }
}
```

```bash
# Build
cd android
./gradlew assembleRelease
# APK at: android/app/build/outputs/apk/release/app-release.apk
```

### Why the Kotlin Patch
RN 0.76.9 forces KGP 1.9.25 via a settings-level version catalog (`libs.versions.toml`). Expo's Compose Compiler requires a specific Kotlin version match. The suppress flag bypasses this check.

---

## 7. Debugging Next Steps

### If PR #13 still crashes:

1. **Get logcat output** — this is the #1 missing piece:
   ```bash
   adb logcat -s ReactNativeJS AndroidRuntime | tee crash.log
   ```
   - `ReactNativeJS` = JS console.log/errors
   - `AndroidRuntime` = native crash stack traces
   
   **We need the actual stack trace to proceed. Without it, we're guessing.**

2. **Check if the Metro patch is actually working:**
   The `[Polyfills]` console.log messages should appear in logcat. If you see:
   ```
   [Polyfills] Starting...
   [Polyfills] Buffer OK: function
   [Polyfills] crypto.getRandomValues OK
   [Polyfills] All done!
   ```
   Then polyfills loaded. If the crash happens AFTER this, it's in GramJS code.

3. **Test if the GramJS crypto patch is loaded:**
   Add to `patches/gramjs-crypto.js` line 1:
   ```js
   console.log('[GramJS Crypto Patch] LOADED — using crypto-browserify');
   ```
   If this doesn't appear in logcat, Metro isn't redirecting properly.

4. **Possible remaining issues:**
   - `telegram/crypto/AuthKey.js` or other files might import `./crypto` and get the ORIGINAL (unpatched) file if Metro's resolver doesn't catch relative imports within node_modules
   - The `platform.js` `isNode=true` detection might cause Node-specific code paths elsewhere
   - `randombytes` (used by crypto-browserify) might fail if `crypto.getRandomValues` isn't ready

5. **Nuclear option — use `patch-package`:**
   ```bash
   npm install patch-package --save-dev
   ```
   Then directly edit `node_modules/telegram/crypto/crypto.js` to replace the Web Crypto calls with crypto-browserify, and run:
   ```bash
   npx patch-package telegram
   ```
   This creates a `patches/telegram+X.Y.Z.patch` file that auto-applies on every `npm install`. More reliable than Metro resolver hacks.

### Alternative approaches not yet tried:

- **Use `patch-package`** to permanently patch `node_modules/telegram/crypto/crypto.js` (survives `npm install`)
- **Fork `gramjs`** on npm, replace the crypto module, publish as scoped package
- **Use `tdlib` via native module** instead of gramjs (Rust/C++ Telegram client, much more robust but complex integration)

---

## 8. GitHub Credentials

- **Fork:** `R1ghTsS/Telegram-Drive-Mobile`
- **Branch:** `fix/gramjs-auth-comprehensive`
- **Upstream:** `0xJhinkz/Telegram-Drive-Mobile` (master)
- **Auth token:** Ask the user for the GitHub PAT — do NOT hardcode it
- PRs are created via GitHub API with the user's token

---

## 9. Reference Repos (from project owner)

- https://github.com/caamer20/Telegram-Drive/tree/main/app/src-tauri — Tauri (Rust) desktop version, uses `grammers` Rust crate for auth (not JS)
- https://github.com/telegram-mini-apps-dev/TelegramUI — UI components for Telegram Mini Apps

---

## 10. Critical Rules

- **NEVER restart the VPS or running data pipelines.** This project is unrelated to the Hyperliquid/Polymarket infrastructure.
- **NEVER use `ssh root@159.195.52.128 "command"` pattern** — use interactive SSH sessions.
- The `react-native-get-random-values` dependency is the primary CSPRNG source. **Do not disable or fall back to `Math.random()`.**
