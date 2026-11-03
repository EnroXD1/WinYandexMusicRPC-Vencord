# Attribution

This is a separate Vencord userplugin prepared for EnroXD1. It is not an official release of WinYandexMusicRPC, Vencord, Discord, or Yandex.

The original utility is [FozerG/WinYandexMusicRPC](https://github.com/FozerG/WinYandexMusicRPC), copyright (c) 2023 FozerG, MIT license. Its Windows-media approach, public Discord application ID and presence behavior informed this implementation. The original license is included as `LICENSE-WinYandexMusicRPC`.

The native/renderer integration follows Vencord's public plugin APIs and its MusicRichPresence implementation. Plugin source is licensed under GPL-3.0-or-later; the full GPL text is in `LICENSE`.

The Ynison handshake and registration format were checked against [MarshalX/yandex-music-api](https://github.com/MarshalX/yandex-music-api), licensed LGPL-3.0. This plugin implements the JSON protocol in TypeScript and does not bundle or execute that Python library. Its license is included as `LICENSE-yandex-music-api`.

The current JSON field names and omission of default values were additionally checked against the request schema in [thedvxch/yandex-music](https://github.com/thedvxch/yandex-music/blob/main/src/ynison/messages.ts).

The required `ws` package is installed from the npm registry into the user's Vencord checkout and retains its own MIT license. It is not included in this source archive.

No Yandex or Discord user credentials are included in the package.
