/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "crypto";
import WebSocket from "ws";

import type { MediaSession, MediaSnapshot } from "./media";
import { currentTrackId, describeYnisonFailure, initialState, normalizeYnisonState, stateHost, type YnisonFailure,ynisonSession } from "./ynisonProtocol";

function firstFrame(url: string, token: string, deviceId: string, signal: AbortSignal, redirect?: { redirect_ticket: string; session_id: string | number; }, message?: object): Promise<any> {
    const stage = message ? "state" : "redirect";
    const device: Record<string, string> = { "Ynison-Device-Id": deviceId, "Ynison-Device-Info": JSON.stringify({ app_name: "Vencord", type: "1" }) };
    if (redirect) {
        device["Ynison-Redirect-Ticket"] = redirect.redirect_ticket;
        device["Ynison-Session-Id"] = String(redirect.session_id);
    }
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("Ynison отключён."));
        const socket = new WebSocket(url, ["Bearer", "v2", encodeURIComponent(JSON.stringify(device))], {
            headers: { Origin: "https://music.yandex.ru", Authorization: `OAuth ${token}` },
            handshakeTimeout: 8000, maxPayload: 64 * 1024 * 1024, followRedirects: false, perMessageDeflate: false
        });
        let done = false;
        const finish = (error?: Error, value?: unknown) => {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            signal.removeEventListener("abort", abort);
            socket.terminate();
            if (error) reject(error);
            else resolve(value);
        };
        const timeout = setTimeout(() => finish(new Error("Ynison не ответил за 10 секунд.")), 10000);
        const abort = () => finish(new Error("Ynison отключён."));
        signal.addEventListener("abort", abort, { once: true });
        socket.on("open", () => { if (message && !done) socket.send(JSON.stringify(message)); });
        socket.on("error", () => finish(new Error(`Ynison (${stage === "redirect" ? "авторизация" : "состояние"}): ошибка сети или TLS.`)));
        socket.on("unexpected-response", (_request, response) => {
            response.resume();
            const failure = describeYnisonFailure({ http_code: response.statusCode }, stage);
            finish(Object.assign(new Error(failure.message), failure));
        });
        socket.on("close", () => finish(new Error("Ynison закрыл соединение.")));
        socket.on("message", (data, binary) => {
            if (done) return;
            try {
                if (binary) throw new Error();
                const value = JSON.parse(data.toString());
                if (!value || typeof value !== "object") throw new Error();
                if (value.error) {
                    const failure = describeYnisonFailure(value.error, stage);
                    return finish(Object.assign(new Error(failure.message), failure));
                }
                if (message && !value.player_state && !value.playerState && !Array.isArray(value.devices)) return;
                finish(undefined, value);
            } catch {
                finish(new Error("Некорректный ответ Ynison."));
            }
        });
    });
}

export function createYnisonReader(readToken: () => Promise<string | null>) {
    let active = false;
    let generation = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let snapshot: MediaSnapshot = { supported: true, state: "stopped", sessions: [] };
    const deviceId = randomUUID().replaceAll("-", "").slice(0, 16);
    const tracks = new Map<string, Pick<MediaSession, "title" | "artist" | "album" | "duration" | "cover" | "url">>();

    async function poll(epoch: number) {
        const abort = controller = new AbortController();
        let failed = false;
        let terminal = false;
        let retryAfterMs = 10000;
        try {
            const token = await readToken();
            if (!active || epoch !== generation) return;
            if (!token) throw new Error("Добавьте OAuth-токен Яндекс Музыки в настройках плагина.");
            const answer = await firstFrame("wss://ynison.music.yandex.ru/redirector.YnisonRedirectService/GetRedirectToYnison", token, deviceId, abort.signal);
            const redirect = { host: answer.host, redirect_ticket: answer.redirect_ticket ?? answer.redirectTicket, session_id: answer.session_id ?? answer.sessionId };
            if (typeof redirect.host !== "string" || typeof redirect.redirect_ticket !== "string" || !redirect.redirect_ticket || !redirect.session_id) throw new Error("Неполный ответ перенаправления Ynison.");
            const state = normalizeYnisonState(await firstFrame(stateHost(redirect.host), token, deviceId, abort.signal, redirect, initialState(deviceId, randomUUID())));
            const id = currentTrackId(state);
            if (!id) {
                if (active && epoch === generation) snapshot = { supported: true, state: "ready", sessions: [] };
                return;
            }
            let track = tracks.get(id);
            if (!track) {
                const response = await fetch("https://api.music.yandex.net/tracks", {
                    method: "POST",
                    headers: { Authorization: `OAuth ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
                    body: new URLSearchParams({ "track-ids": id, "with-positions": "false" }).toString(),
                    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]), redirect: "error"
                });
                if (!response.ok) throw new Error(`Яндекс Музыка не вернула данные трека (HTTP ${response.status}).`);
                const body = await response.json();
                const data = body.result?.[0];
                if (typeof data?.title !== "string") throw new Error("Яндекс Музыка не вернула название трека.");
                const albumId = data.albums?.[0]?.id;
                const trackId = id.split(":")[0];
                let cover: string | undefined;
                const coverUri = data.ogImage || data.coverUri;
                if (typeof coverUri === "string") {
                    const url = new URL(`https://${coverUri.replace(/^https?:\/\//, "").replace("%%", "512x512")}`);
                    if (/\.(yandex\.(net|ru)|yandex-team\.ru)$/.test(url.hostname)) cover = url.href;
                }
                track = {
                    title: `${data.title}${data.version ? ` (${data.version})` : ""}`,
                    artist: (data.artists || []).map((a: { name?: string; }) => a.name || "").filter(Boolean).join(", "),
                    album: data.albums?.[0]?.title || "", duration: Number(data.durationMs) / 1000 || 0, cover,
                    url: `https://music.yandex.ru/${albumId ? `album/${encodeURIComponent(albumId)}/` : ""}track/${trackId}`
                };
                if (tracks.size >= 128) tracks.delete(tracks.keys().next().value!);
                tracks.set(id, track);
            }
            if (active && epoch === generation) snapshot = { supported: true, state: "ready", sessions: [ynisonSession(state, track, Date.now())] };
        } catch (error) {
            failed = true;
            if (error instanceof Error) {
                const failure = error as Error & Partial<YnisonFailure>;
                terminal = failure.terminal === true;
                if (Number.isFinite(failure.retryAfterMs)) retryAfterMs = failure.retryAfterMs!;
            }
            if (active && epoch === generation) snapshot = { supported: true, state: "error", sessions: [], error: error instanceof Error ? error.message : "Ошибка Ynison." };
        } finally {
            if (active && epoch === generation && !terminal) timer = setTimeout(() => { void poll(epoch); }, failed ? retryAfterMs : 3000);
        }
    }

    const stop = () => {
        active = false;
        ++generation;
        clearTimeout(timer);
        controller?.abort();
        snapshot = { supported: true, state: "stopped", sessions: [] };
        tracks.clear();
    };
    return {
        start() {
            stop();
            active = true;
            snapshot = { supported: true, state: "starting", sessions: [] };
            void poll(generation);
        },
        stop,
        getSnapshot: () => snapshot
    };
}
