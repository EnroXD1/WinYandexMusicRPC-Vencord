Пользовательский плагин Vencord для музыкальной активности Discord: медиаплееры Windows и аккаунт Яндекс Музыки через Ynison.

## Установка

1. Скачайте ZIP установщика из раздела **Assets** и полностью распакуйте его.
2. Запустите **INSTALL.cmd** и нажмите Enter. Обычный Vencord должен быть установлен заранее.
3. После запуска Discord включите **WinYandexMusicRPC** в разделе **Vencord → Plugins**.

Git, Node.js и Python для готового пакета не требуются. **RESTORE.cmd** возвращает предыдущую сборку из резервной копии. Установщик заменяет Vencord runtime целиком; другие сторонние плагины автоматически не объединяются.

Для источника Windows токен не нужен. Для Ynison сохраните OAuth-токен Яндекс Музыки в настройках плагина. Discord должен оставаться запущенным на ПК.

В архиве приложены исходники соответствующей сборки (`SOURCE.zip`) и лицензии. Рядом с ZIP доступна контрольная сумма SHA-256.

**Оригинальная утилита — [FozerG/WinYandexMusicRPC](https://github.com/FozerG/WinYandexMusicRPC), автор FozerG. Этот проект — отдельный порт для Vencord от EnroXD1.** Лицензия порта: GPL-3.0-or-later; MIT-лицензия и уведомление об авторстве оригинальной утилиты сохранены.

Подробности версии — в [CHANGELOG](https://github.com/EnroXD1/WinYandexMusicRPC-Vencord/blob/main/CHANGELOG.md), инструкции — в [README](https://github.com/EnroXD1/WinYandexMusicRPC-Vencord#readme).
