# WinYandexMusicRPC for Vencord

[Русский README](README.md) · [Download installer](https://github.com/EnroXD1/WinYandexMusicRPC-Vencord/releases/latest)

Yandex Music Rich Presence for Vencord, with Windows media-session support and account playback through Ynison. Displays the track, artist, album artwork, progress and pause state in your Discord profile.

> **Original project: [FozerG/WinYandexMusicRPC](https://github.com/FozerG/WinYandexMusicRPC), created by FozerG.** This repository is a separate Vencord port maintained by **EnroXD1**. Original authorship and the upstream MIT license are preserved; see [NOTICE.md](NOTICE.md).

## Install

1. Install regular [Vencord](https://vencord.dev/download).
2. Download the installer ZIP from [Releases](https://github.com/EnroXD1/WinYandexMusicRPC-Vencord/releases/latest).
3. Extract the entire archive and run `INSTALL.cmd`.
4. Enable **WinYandexMusicRPC** in Discord Settings → Vencord → Plugins.
5. Allow activity sharing in Discord's activity privacy settings.

The prebuilt installer needs Windows 10/11 and an existing Vencord installation. Git, Node.js and Python are not required. It replaces the Vencord runtime with a custom build and keeps a recovery copy. Run `RESTORE.cmd` to restore the preceding build. Existing third-party plugins are not merged automatically.

## Sources

- **Windows:** select Windows applications and browsers, restart Discord, and play music. No OAuth token is required. The player must publish media-session metadata to Windows.
- **Ynison:** save a Yandex Music OAuth token in plugin settings and use the same account on your playback device. The token check button reports whether the Music API accepts the credential.

Discord must remain open on the computer. Ynison is an unofficial service interface and depends on the service and playback device. A hidden Windows PowerShell reader is managed by the Windows mode.

Tokens are encrypted using Electron safeStorage / Windows DPAPI. Optional iTunes artwork lookup sends the track title and artist to Apple. See the [privacy notes](docs/PRIVACY.md).

## Build

With Git, Node.js 24 and pnpm available on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build.ps1 -Package
```

The build script uses an isolated, pinned Vencord checkout, runs tests and packages the installer. It does not modify the installed Discord client. See [development notes](docs/DEVELOPMENT.md).

Port code: [GPL-3.0-or-later](LICENSE). Original utility: MIT. This is an independent userplugin, not an official release of FozerG, Vencord, Discord or Yandex.
