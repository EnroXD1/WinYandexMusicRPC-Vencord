# WinYandexMusicRPC

Vencord userplugin 1.0.1: Yandex Music presence from a phone via Ynison, or from Windows media sessions.

Copy this entire folder to `Vencord/src/userplugins/`. In the Vencord root install `ws@8.22.1` and `@types/ws@8.18.2`, then rebuild Vencord with `pnpm build --dev` and install your custom build. A complete Russian installation guide is included as `README.md` at the root of the distribution archive.

For phone playback, enter a Yandex Music OAuth token in this plugin's settings. It is encrypted by Electron safeStorage and is not stored in synced Vencord settings. Discord must remain open on the computer.

Version 1.0.1 fixes the Ynison registration JSON schema and distinguishes protocol errors from authentication failures. The Check Token button separately tests the stored credential against the Yandex Music account API and returns a sanitized result.

For Windows playback, choose the Windows source and restart Discord. No token or Python is needed. A hidden Windows PowerShell reader is managed by the plugin.

Phone/Ynison support has automated protocol tests; a live account test is still required after installation. Windows media reading has been tested with a real Chrome media session. See `NOTICE.md` for attribution and license information.
