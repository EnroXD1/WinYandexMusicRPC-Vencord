/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, type PluginNative } from "@utils/types";
import type { Activity } from "@vencord/discord-types";
import { ActivityFlags, ActivityStatusDisplayType, ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, FluxDispatcher, React, showToast, TextInput, useEffect, useState } from "@webpack/common";

import { DEFAULT_APPLICATION_ID, type MediaSession, type MediaSnapshot, playbackTimes, selectSession, trackKey } from "./media";

const Native = VencordNative.pluginHelpers.WinYandexMusicRPC as PluginNative<typeof import("./native")>;
const logger = new Logger("WinYandexMusicRPC");
const SOCKET_ID = "WinYandexMusicRPC";

const settings = definePluginSettings({
    sourceMode: {
        type: OptionType.SELECT,
        description: "Источник музыки. После смены перезапустите Discord.",
        restartNeeded: true,
        options: [
            { label: "Аккаунт Яндекс Музыки / телефон (Ynison)", value: "ynison", default: true },
            { label: "Приложения и браузеры Windows", value: "windows" }
        ] as const
    },
    token: {
        type: OptionType.COMPONENT,
        description: "OAuth-токен Яндекса (нужен только для Ynison).",
        component: ErrorBoundary.wrap(TokenEditor, { noop: false })
    },
    sourceFilter: {
        type: OptionType.STRING,
        description: "Режим Windows: часть имени приложения. Пусто — все плееры; yandex — приложения Яндекса. Имена видны выше.",
        default: ""
    },
    preferYandex: {
        type: OptionType.BOOLEAN,
        description: "Отдавать приоритет Яндекс Музыке среди одновременно играющих приложений.",
        default: true
    },
    pauseTimeout: {
        type: OptionType.NUMBER,
        description: "Через сколько секунд скрывать статус на паузе: 0 — сразу, -1 — никогда.",
        default: 30
    },
    statusName: {
        type: OptionType.STRING,
        description: "Название активности. Подстановки: {title}, {artist}, {album}.",
        default: "Яндекс Музыку"
    },
    memberList: {
        type: OptionType.SELECT,
        description: "Что показывать после «Слушает» в списке участников.",
        options: [
            { label: "Название активности", value: "name", default: true },
            { label: "Название трека", value: "title" },
            { label: "Исполнитель", value: "artist" }
        ]
    },
    showCover: {
        type: OptionType.BOOLEAN,
        description: "Показывать обложку Яндекса в Ynison. В Windows искать через iTunes: название и исполнитель отправляются Apple.",
        default: true
    },
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Кнопка открытия трека (Ynison) или поиска в Яндекс Музыке (Windows).",
        default: true
    },
    applicationId: {
        type: OptionType.STRING,
        description: "Discord Application ID. По умолчанию используется публичное приложение исходной утилиты.",
        default: DEFAULT_APPLICATION_ID,
        isValid: value => (typeof value === "string" && /^\d{17,20}$/.test(value)) || "Нужен Application ID из 17–20 цифр."
    }
});

let running = false;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let previousSource: string | undefined;
let identity = "";
let pausedAt: number | undefined;
let anchor: { start: number; end?: number; } | undefined;
let lastPayload = "";
let lastError = "";
const assetCache = new Map<string, string>();
const coverCache = new Map<string, string | null>();

function publish(activity: Activity | null) {
    const payload = JSON.stringify(activity);
    if (lastPayload === payload) return;
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET_ID });
    lastPayload = payload;
}

function reportError(message: string) {
    if (message === lastError) return;
    lastError = message;
    logger.error(message);
    showToast({ text: `WinYandexMusicRPC: ${message}`, variant: "critical" });
}

async function asset(applicationId: string, key: string): Promise<string | undefined> {
    const cacheKey = `${applicationId}:${key}`;
    if (assetCache.has(cacheKey)) return assetCache.get(cacheKey);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const ids = await Promise.race([
            ApplicationAssetUtils.fetchAssetIds(applicationId, [key]),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Asset lookup timed out")), 4000); })
        ]);
        if (!ids[0]) return;
        if (assetCache.size >= 128) assetCache.delete(assetCache.keys().next().value!);
        assetCache.set(cacheKey, ids[0]);
        return ids[0];
    } catch {
        return;
    } finally {
        clearTimeout(timeout);
    }
}

function clip(value: string, fallback = ""): string {
    return Array.from(value.trim() || fallback).slice(0, 128).join("");
}

async function makeActivity(media: MediaSession, epoch: number): Promise<Activity | null> {
    const opts = { ...settings.store };
    const appId = /^\d{17,20}$/.test(opts.applicationId) ? opts.applicationId : DEFAULT_APPLICATION_ID;
    const key = trackKey(media);
    let cover: string | null = null;
    if (opts.showCover && media.cover) cover = media.cover;
    else if (opts.showCover) {
        if (coverCache.has(key)) cover = coverCache.get(key)!;
        else {
            cover = await Native.findArtwork(media.title, media.artist, media.duration);
            if (coverCache.size >= 128) coverCache.delete(coverCache.keys().next().value!);
            coverCache.set(key, cover);
        }
    }
    const image = await asset(appId, cover || "music_note");
    if (!running || generation !== epoch) return null;
    const now = Date.now();
    const times = playbackTimes(media, now);
    if (!times) anchor = undefined;
    else if (!anchor || Math.abs(times.start - anchor.start) > 2500 || Math.abs((times.end ?? 0) - (anchor.end ?? 0)) > 2500) anchor = times;

    const name = opts.statusName.replace(/\{(title|artist|album)\}/g, (_, field: "title" | "artist" | "album") => media[field]);
    const search = `https://music.yandex.ru/search?text=${encodeURIComponent(`${media.artist} ${media.title}`.trim())}`;
    const playing = media.status === "playing";
    return {
        application_id: appId,
        name: clip(name, "Яндекс Музыку"),
        type: ActivityType.LISTENING,
        flags: ActivityFlags.INSTANCE,
        details: clip(media.title),
        state: clip(`${playing ? "" : "⏸ "}${media.artist || "Неизвестный исполнитель"}`),
        status_display_type: { name: ActivityStatusDisplayType.NAME, title: ActivityStatusDisplayType.DETAILS, artist: ActivityStatusDisplayType.STATE }[opts.memberList],
        timestamps: times ? anchor : undefined,
        assets: image ? { large_image: image, large_text: clip(`${playing ? "" : "Пауза · "}${media.album || media.title}`) } : undefined,
        details_url: media.url,
        buttons: opts.showButton ? [media.url ? "Открыть в Яндекс Музыке" : "Найти в Яндекс Музыке"] : undefined,
        metadata: opts.showButton ? { button_urls: [media.url || search] } : undefined
    };
}

async function poll(epoch: number) {
    try {
        const snapshot = await Native.getSnapshot();
        if (!running || epoch !== generation) return;
        if (!snapshot.supported) {
            reportError("Требуется настольный Discord на Windows 10/11.");
            publish(null);
            return;
        }
        if (snapshot.error) reportError(snapshot.error);
        else if (snapshot.state === "ready") lastError = "";
        const filter = settings.store.sourceMode === "windows" ? settings.store.sourceFilter : "";
        const media = selectSession(snapshot.sessions, filter, settings.store.preferYandex, previousSource);
        if (!media) {
            identity = "";
            previousSource = undefined;
            pausedAt = undefined;
            anchor = undefined;
            publish(null);
            return;
        }
        const key = trackKey(media);
        if (key !== identity) {
            identity = key;
            pausedAt = undefined;
            anchor = undefined;
        }
        previousSource = media.source;
        if (media.status === "playing") pausedAt = undefined;
        else pausedAt ??= Date.now();
        const timeout = Number.isFinite(settings.store.pauseTimeout) ? settings.store.pauseTimeout : 30;
        if (pausedAt !== undefined && timeout >= 0 && Date.now() - pausedAt >= timeout * 1000) {
            anchor = undefined;
            publish(null);
            return;
        }
        const activity = await makeActivity(media, epoch);
        if (!running || epoch !== generation) return;
        // The player may have stopped or changed while artwork was loading.
        const fresh = await Native.getSnapshot();
        if (!running || epoch !== generation) return;
        const latest = selectSession(fresh.sessions, filter, settings.store.preferYandex, previousSource);
        if (!latest || trackKey(latest) !== key || latest.status !== media.status) {
            publish(null);
            return;
        }
        publish(activity);
    } catch (error) {
        if (!running || epoch !== generation) return;
        reportError(String(error));
        publish(null);
    } finally {
        if (running && epoch === generation) timer = setTimeout(() => { void poll(epoch); }, 1000);
    }
}

function TokenEditor() {
    const [value, setValue] = useState("");
    const [saved, setSaved] = useState<boolean>();
    const [busy, setBusy] = useState(false);
    const [checkResult, setCheckResult] = useState("");
    useEffect(() => { void Native.getTokenState().then(setSaved).catch(() => setSaved(false)); }, []);
    const save = async (token: string) => {
        setBusy(true);
        try {
            setSaved(await Native.saveToken(token));
            setValue("");
            setCheckResult("");
            showToast({ text: token ? "Токен сохранён. Подключение к Ynison…" : "Токен удалён.", variant: "success" });
        } catch (error) {
            showToast({ text: String(error), variant: "critical" });
        } finally { setBusy(false); }
    };
    const check = async () => {
        setBusy(true);
        try {
            const result = await Native.checkToken();
            setCheckResult(result.message);
        } catch { setCheckResult("Не удалось выполнить проверку токена."); }
        finally { setBusy(false); }
    };
    return <>
        <Paragraph>{saved ? "Токен сохранён с системным шифрованием." : "Добавьте OAuth-токен Яндекс Музыки для режима Ynison."} Пароль от аккаунта не нужен.</Paragraph>
        <TextInput type="password" value={value} onChange={setValue} placeholder="OAuth-токен Яндекс Музыки" />
        <Button disabled={busy || !value.trim()} onClick={() => { void save(value); }}>Сохранить токен</Button>
        <Button disabled={busy || !saved} variant="secondary" onClick={() => { void check(); }}>Проверить токен</Button>
        <Button disabled={busy || !saved} variant="secondary" onClick={() => { void save(""); }}>Удалить токен</Button>
        {checkResult && <Paragraph>{checkResult}</Paragraph>}
    </>;
}

const About = ErrorBoundary.wrap(() => {
    const [snapshot, setSnapshot] = useState<MediaSnapshot>();
    useEffect(() => {
        let mounted = true;
        const refresh = () => Native.getSnapshot().then(value => { if (mounted) setSnapshot(value); }).catch(() => {});
        void refresh();
        const interval = setInterval(refresh, 2000);
        return () => { mounted = false; clearInterval(interval); };
    }, []);
    return <>
        <Paragraph>WinYandexMusicRPC 1.0.1</Paragraph>
        <Paragraph>Показывает музыку с телефона через аккаунт Яндекса или из медиаплееров Windows. Включите передачу активности в настройках конфиденциальности Discord.</Paragraph>
        <Paragraph>Состояние: {snapshot ? (!snapshot.supported ? "Нужна Windows 10/11" : ({ stopped: "Отключён", starting: "Подключение", ready: "Готов", error: "Ошибка" }[snapshot.state])) : "Проверка…"}</Paragraph>
        {snapshot?.error && <Paragraph>{snapshot.error}</Paragraph>}
        <Paragraph>Найденные приложения: {snapshot?.sessions.map(s => s.source).join(", ") || "Пока нет. Запустите воспроизведение."}</Paragraph>
    </>;
}, { noop: false });

export default definePlugin({
    name: "WinYandexMusicRPC",
    description: "Статус «Слушает» из Яндекс Музыки на телефоне через Ynison или медиаплееров Windows.",
    authors: [{ name: "EnroXD1", id: 0n }],
    tags: ["Activity", "Media"],
    settings,
    settingsAboutComponent: About,

    start() {
        running = true;
        const epoch = ++generation;
        lastPayload = "";
        lastError = "";
        void Native.start(settings.store.sourceMode).then(() => {
            if (running && epoch === generation) void poll(epoch);
        }).catch(error => { if (running && epoch === generation) reportError(String(error)); });
    },

    stop() {
        running = false;
        ++generation;
        clearTimeout(timer);
        identity = "";
        previousSource = undefined;
        pausedAt = undefined;
        anchor = undefined;
        publish(null);
        void Native.stop().catch(error => logger.error("Could not stop Windows media reader", error));
    }
});
