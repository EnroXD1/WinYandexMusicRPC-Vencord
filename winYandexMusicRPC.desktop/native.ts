/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SETTINGS_DIR } from "@main/utils/constants";
import { ChildProcess, spawn } from "child_process";
import { IpcMainInvokeEvent, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

import { matchesArtwork, type MediaSession, type MediaSnapshot } from "./media";
import { WINDOWS_MEDIA_SCRIPT } from "./windowsMedia";
import { createYnisonReader } from "./ynison";

let worker: ChildProcess | undefined;
let enabled = false;
let lastUpdate = 0;
let retryAt = 0;
let mode: "windows" | "ynison" = "windows";
let snapshot: MediaSnapshot = { supported: process.platform === "win32", state: "stopped", sessions: [] };
const tokenPath = join(SETTINGS_DIR, "winyandexmusicrpc-token.bin");
async function readToken(): Promise<string | null> {
    if (!existsSync(tokenPath)) return null;
    return safeStorage.decryptString(readFileSync(tokenPath));
}
const ynison = createYnisonReader(readToken);

function stopWorker() {
    const child = worker;
    worker = undefined;
    child?.kill();
}

function fail(message: string) {
    stopWorker();
    snapshot = { supported: true, state: "error", sessions: [], error: message.slice(0, 500) };
    retryAt = Date.now() + 10000;
}

function startWorker() {
    if (mode !== "windows" || worker || !enabled || process.platform !== "win32" || Date.now() < retryAt) return;
    snapshot = { supported: true, state: "starting", sessions: [] };
    lastUpdate = Date.now();
    const script = WINDOWS_MEDIA_SCRIPT.replace("__PARENT_PID__", String(process.pid));
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = worker = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
    });
    let buffer = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (data: string) => { stderr = (stderr + data).slice(-1000); });
    child.stdout!.on("data", (data: string) => {
        if (worker !== child) return;
        buffer += data;
        if (buffer.length > 1024 * 1024) return fail("Windows media response is too large.");
        let end: number;
        while ((end = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (!line) continue;
            try {
                const value = JSON.parse(line);
                if (typeof value.error === "string") return fail(value.error);
                if (!Array.isArray(value.sessions)) return fail("Invalid Windows media response.");
                const sessions: MediaSession[] = value.sessions.filter((s: MediaSession) =>
                    [s.source, s.title, s.artist, s.album].every(v => typeof v === "string" && v.length <= 8192)
                    && [s.position, s.duration, s.rate, s.observedAt].every(Number.isFinite)
                    && (s.status === "playing" || s.status === "paused")
                );
                lastUpdate = Date.now();
                snapshot = { supported: true, state: "ready", sessions };
            } catch {
                return fail("Could not decode Windows media response.");
            }
        }
    });
    child.on("error", error => { if (worker === child) fail(error.message); });
    child.on("close", code => { if (worker === child) fail(stderr || `Windows media reader exited (${code}).`); });
}

process.once("exit", () => { stopWorker(); ynison.stop(); });

export function start(_event: IpcMainInvokeEvent, source: "windows" | "ynison" = "windows") {
    if (source !== "windows" && source !== "ynison") throw new Error("Неизвестный источник музыки.");
    stop(_event);
    mode = source;
    enabled = true;
    retryAt = 0;
    if (mode === "ynison") ynison.start();
    else startWorker();
    return getSnapshot(_event);
}

export function stop(_event: IpcMainInvokeEvent) {
    enabled = false;
    stopWorker();
    ynison.stop();
    snapshot = { supported: process.platform === "win32", state: "stopped", sessions: [] };
}

export function getSnapshot(_event: IpcMainInvokeEvent): MediaSnapshot {
    if (mode === "ynison") return ynison.getSnapshot();
    if (worker && Date.now() - lastUpdate > 15000) fail("Windows media reader did not respond for 15 seconds.");
    startWorker();
    return snapshot;
}

export function getTokenState(_event: IpcMainInvokeEvent): boolean {
    return existsSync(tokenPath);
}

export async function checkToken(_event: IpcMainInvokeEvent): Promise<{ ok: boolean; message: string; }> {
    try {
        const token = await readToken();
        if (!token) return { ok: false, message: "Сначала сохраните OAuth-токен Яндекс Музыки." };
        const response = await fetch("https://api.music.yandex.net/account/status", {
            headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(8000), redirect: "error"
        });
        if (response.status === 401) return { ok: false, message: "API Яндекс Музыки не принял токен (HTTP 401). Получите новый токен и сохраните его." };
        if (response.status === 403) return { ok: false, message: "API Яндекс Музыки запретил доступ (HTTP 403). У токена может не быть нужных прав." };
        if (!response.ok) return { ok: false, message: `API Яндекс Музыки недоступен (HTTP ${response.status}).` };
        const body = await response.json();
        if (Number(body.result?.account?.uid) > 0) return { ok: true, message: "Токен принят API Яндекс Музыки. Если Ynison выдаёт ошибку, смотрите её отдельный код выше." };
        return { ok: false, message: "API Яндекс Музыки не подтвердил авторизованный аккаунт. Сохраните токен с доступом к Музыке." };
    } catch {
        return { ok: false, message: "Проверка не завершена: ошибка сети, TLS или системного хранилища токена." };
    }
}

export function saveToken(_event: IpcMainInvokeEvent, value: string): boolean {
    if (typeof value !== "string") throw new Error("Некорректный токен.");
    const token = value.trim().replace(/^OAuth\s+/i, "");
    if (token && !/^[A-Za-z0-9._~-]{10,4096}$/.test(token)) throw new Error("Вставьте только OAuth-токен, без URL и других символов.");
    if (token) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("Системное шифрование недоступно. Токен не сохранён.");
        mkdirSync(SETTINGS_DIR, { recursive: true });
        writeFileSync(tokenPath, safeStorage.encryptString(token));
    } else if (existsSync(tokenPath)) unlinkSync(tokenPath);
    if (enabled && mode === "ynison") ynison.start();
    return Boolean(token);
}

const artworkCache = new Map<string, string | null>();

export async function findArtwork(_event: IpcMainInvokeEvent, title: string, artist: string, duration: number): Promise<string | null> {
    if (typeof title !== "string" || typeof artist !== "string" || title.length > 512 || artist.length > 512 || !Number.isFinite(duration) || duration < 0) return null;
    if (!title.trim() || !artist.trim()) return null;
    const key = JSON.stringify([title, artist, Math.round(duration)]);
    if (artworkCache.has(key)) return artworkCache.get(key)!;
    let artwork: string | null = null;
    try {
        const params = new URLSearchParams({ term: `${artist} ${title}`, entity: "song", limit: "10" });
        const response = await fetch(`https://itunes.apple.com/search?${params}`, { signal: AbortSignal.timeout(5000), redirect: "error" });
        if (!response.ok) return null;
        const body = await response.json();
        const match = body.results?.find((r: { trackName?: string; artistName?: string; trackTimeMillis?: number; }) => matchesArtwork(title, artist, duration, r));
        if (match?.artworkUrl100) {
            const url = new URL(match.artworkUrl100);
            if (url.protocol === "https:" && url.hostname.endsWith(".mzstatic.com")) {
                artwork = url.href.replace("100x100bb", "512x512bb");
            }
        }
    } catch {
        // Artwork is optional; network errors must not hide the track.
    }
    if (artworkCache.size >= 128) artworkCache.delete(artworkCache.keys().next().value!);
    artworkCache.set(key, artwork);
    return artwork;
}
