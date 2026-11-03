# Разработка и сборка

## Структура

```text
winYandexMusicRPC.desktop/  Плагин, native-методы и модульные тесты
installer/                 Установка, восстановление и упаковка Windows
validation/                Интеграционные проверки с имитацией API
scripts/                   Подготовка Vencord, проверки и сборка
docs/                      Документация
assets/                    Оформление README
```

Проверенная база Vencord: `8d64c8be7e68616f8f116a6fff9480051aa2a0c5` / `1.15.15`. Она записана в `package.json`. Плагину нужны прямые зависимости `ws@8.22.1` и `@types/ws@8.18.2` в checkout Vencord.

## Полный цикл

На Windows с Git, Node.js 24 и pnpm:

```powershell
git clone https://github.com/EnroXD1/WinYandexMusicRPC-Vencord.git
cd WinYandexMusicRPC-Vencord
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build.ps1 -Package
```

Скрипт создаёт собственный checkout в `work/Vencord`, устанавливает зависимости, копирует плагин, выполняет проверки, затем `pnpm build --dev --standalone --disable-updater`. Готовый архив появляется в `out/`.

При повторном запуске используется тот же checkout. Редактируйте исходники плагина в корне этого репозитория: рабочая копия плагина в Vencord обновляется из них.

Только проверки, без компиляции runtime:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build.ps1 -SkipBuild
```

Чтобы использовать уже подготовленный checkout Vencord:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Build.ps1 -VencordPath "D:\Projects\Vencord" -Package
```

Этот вариант копирует плагин и добавляет зависимости в указанный checkout, но не меняет установленный Discord. Для ручного подключения собственной сборки используйте официальные [инструкции Vencord](https://docs.vencord.dev/installing/).

## Проверки

- Модульные тесты: приоритет сессий, таймер, обложки, формат регистрации Ynison, ответы snake_case/camelCase, диагностика и задержки сервера.
- TypeScript и ESLint плагина в окружении Vencord.
- `validation/renderer.cjs`: пауза, возобновление, закрытие плеера, отключение и перезапуск при незавершённой загрузке.
- `validation/ynison.cjs`: перенаправление, формат регистрации, метаданные, ошибки авторизации, отмена запросов и защита токена.
- `validation/token.cjs`: принятый, отсутствующий, отклонённый и недостаточный токен на имитации API.
- `installer/Test-Installer.ps1`: тестовые папки, резервное копирование, откат, контрольные суммы, пути и junction.

Живое чтение медиасессии Windows проверяется отдельно и не запускается в CI:

```powershell
node .\validation\windows.cjs .\work\Vencord
```

Тестовые токены в фикстурах вымышленные. Для автоматических тестов настоящие аккаунты или секреты GitHub не нужны.

## Релизы

1. Обновите версию в `package.json`, текст версии в плагине, README установщика и `CHANGELOG.md`.
2. Запустите проверки и упаковку.
3. Создайте Git-тег, совпадающий с версией, например `v1.0.2`, и отправьте его в GitHub.
4. Workflow `release.yml` повторит сборку и приложит установщик к релизу.

Установочный архив содержит `SOURCE.zip`: соответствующий checkout Vencord, исходники плагина, скрипты сборки и лицензии. Готовые бинарные сборки хранятся в Releases, а рабочие checkout и каталоги `dist` не коммитятся в этот репозиторий.

## Источники

Оригинальная утилита — [FozerG/WinYandexMusicRPC](https://github.com/FozerG/WinYandexMusicRPC). Этот репозиторий содержит отдельную реализацию интеграции с Vencord. Сохраняйте сведения об оригинальном авторе и файлы лицензий при изменениях и распространении.
