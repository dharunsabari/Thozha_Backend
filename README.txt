PUBLIC repo (Thozha_Backend, GitHub Pages). Upload ONLY the files in this folder: Thozha-debug.apk and version.json.
NEVER put books, server code, data or keys here - this repo is world-readable.
Only bump version.json to a new version AFTER the matching APK is in this folder.

Files to upload: Thozha-debug.apk, Thozha-previous.apk, version.json, version-rollback.json.
Thozha-previous.apk = the earlier version (for "Go back to earlier version" in Settings). It has a HIGHER versionCode (38) than the current build (37) so Android accepts it as an update. Once rolled back, that app reads version-rollback.json instead of version.json.
NEXT RELEASE: use versionCode 39 or higher, bump APP_VERSION in www/index.html too, then set version-rollback.json "version" to the new version so rolled-back users can update again.
