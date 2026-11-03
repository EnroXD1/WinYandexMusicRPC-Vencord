/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MediaSession } from "./media";

export interface YnisonState {
    player_state?: {
        player_queue?: { current_playable_index?: number; playable_list?: { playable_id?: string; playable_type?: string | number; }[]; };
        status?: { paused?: boolean; progress_ms?: string | number; duration_ms?: string | number; playback_speed?: number; version?: { device_id?: string; timestamp_ms?: string | number; }; };
    };
    active_device_id_optional?: string;
    devices?: { info?: { device_id?: string; title?: string; }; }[];
}

export function stateHost(host: string): string {
    const url = new URL(`wss://${host}`);
    if (url.protocol !== "wss:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
        || (url.port && url.port !== "443") || !/\.yandex\.(net|ru)$/.test(url.hostname)) throw new Error("Ynison вернул недопустимый адрес сервера.");
    return `${url.origin}/ynison_state.YnisonStateService/PutYnisonState`;
}

export function initialState(deviceId: string, requestId: string) {
    return {
        updateFullState: {
            playerState: {
                playerQueue: { currentPlayableIndex: -1, options: { repeatMode: "NONE" }, version: { deviceId }, entityType: "VARIOUS", fromOptional: "" },
                status: { paused: true, playbackSpeed: 1, version: { deviceId } }
            },
            device: {
                capabilities: { canBeRemoteController: true },
                info: { deviceId, type: "WEB", title: "Vencord Music Presence", appName: "Vencord" },
                volumeInfo: {}
            }
        },
        rid: requestId
    };
}

export interface YnisonFailure {
    message: string;
    terminal: boolean;
    retryAfterMs: number;
}

export function describeYnisonFailure(payload: unknown, stage: "redirect" | "state"): YnisonFailure {
    const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const details = (value.details || value.extra_headers || value.extraHeaders || {}) as Record<string, unknown>;
    const numeric = (v: unknown) => (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) ? Number(v) : NaN;
    const http = numeric(value.http_code ?? value.httpCode);
    const grpc = numeric(value.grpc_code ?? value.grpcCode);
    const rawCode = details["ynison-error-code"];
    const code = typeof rawCode === "string" && /^\d{5,12}$/.test(rawCode) ? rawCode : undefined;
    const labels: string[] = [];
    if (http >= 100 && http <= 599) labels.push(`HTTP ${http}`);
    if (grpc >= 0 && grpc <= 16) labels.push(`gRPC ${grpc}`);
    if (code) labels.push(`код ${code}`);
    const parametersNotSet = typeof value.message === "string" && value.message.includes("PARAMETERS_NOT_SET");
    if (parametersNotSet) labels.push("PARAMETERS_NOT_SET");
    let reason = "сервер отклонил запрос";
    const unauthorized = http === 401 || grpc === 16;
    const denied = http === 403 || grpc === 7;
    if (unauthorized) reason = "Яндекс не принял токен. Сохраните новый OAuth-токен Яндекс Музыки";
    else if (denied) reason = "нет доступа к Ynison. Проверьте права и аккаунт токена";
    else if (code === "400090001") reason = "устройство вытеснено другим подключением";
    else if (http === 400 || grpc === 3) reason = "сервер отклонил формат запроса";
    else if (http === 429 || grpc === 8) reason = "слишком много запросов; подключение будет повторено позже";
    else if (http >= 500 || grpc === 14) reason = "сервис временно недоступен";
    const goAway = numeric(details["ynison-go-away-for-seconds"]);
    const rawBackoff = details["ynison-backoff-millis"];
    const backoff = typeof rawBackoff === "string" ? rawBackoff.split(":").map(numeric).filter(Number.isFinite) : [];
    return {
        message: `Ynison (${stage === "redirect" ? "авторизация" : "состояние"}): ${reason}${labels.length ? ` (${labels.join(", ")})` : ""}.`,
        terminal: unauthorized || denied,
        retryAfterMs: Math.min(86400000, Math.max(10000, Number.isFinite(goAway) ? goAway * 1000 : 0, ...backoff))
    };
}

export function normalizeYnisonState(value: Record<string, any>): YnisonState {
    const player = value.player_state ?? value.playerState;
    const queue = player?.player_queue ?? player?.playerQueue;
    const status = player?.status;
    const version = status?.version;
    return {
        player_state: player ? {
            player_queue: queue ? {
                current_playable_index: queue.current_playable_index ?? queue.currentPlayableIndex,
                playable_list: Array.isArray(queue.playable_list ?? queue.playableList) ? (queue.playable_list ?? queue.playableList).map((p: Record<string, any>) => ({ playable_id: p.playable_id ?? p.playableId, playable_type: p.playable_type ?? p.playableType })) : []
            } : undefined,
            status: status ? { paused: status.paused, progress_ms: status.progress_ms ?? status.progressMs, duration_ms: status.duration_ms ?? status.durationMs, playback_speed: status.playback_speed ?? status.playbackSpeed, version: version ? { device_id: version.device_id ?? version.deviceId, timestamp_ms: version.timestamp_ms ?? version.timestampMs } : undefined } : undefined
        } : undefined,
        active_device_id_optional: value.active_device_id_optional ?? value.activeDeviceIdOptional,
        devices: Array.isArray(value.devices) ? value.devices.map(d => ({ info: d.info ? { device_id: d.info.device_id ?? d.info.deviceId, title: d.info.title } : undefined })) : []
    };
}

export function currentTrackId(state: YnisonState): string | undefined {
    const queue = state.player_state?.player_queue;
    const index = queue?.current_playable_index ?? 0;
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(queue?.playable_list)) return;
    const playable = queue.playable_list[index];
    if (playable?.playable_type !== "TRACK" && playable?.playable_type !== 1) return;
    return typeof playable.playable_id === "string" && /^\d+(?::\d+)?$/.test(playable.playable_id) ? playable.playable_id : undefined;
}

export function ynisonSession(state: YnisonState, track: { title: string; artist: string; album: string; duration: number; cover?: string; url?: string; }, now: number): MediaSession {
    const status = state.player_state?.status;
    const rate = Number(status?.playback_speed) || 1;
    const duration = Math.max(0, Number(status?.duration_ms) / 1000 || track.duration);
    const stamp = Number(status?.version?.timestamp_ms);
    const elapsed = Number.isFinite(stamp) && stamp > 0 && now >= stamp && now - stamp < 86400000 ? (now - stamp) / 1000 : 0;
    const paused = status?.paused === true;
    const position = Math.max(0, Number(status?.progress_ms) / 1000 || 0) + (paused ? 0 : elapsed * rate);
    const active = state.active_device_id_optional || status?.version?.device_id;
    const device = state.devices?.find(d => d.info?.device_id === active)?.info?.title || "Яндекс Музыка";
    return { ...track, source: `Yandex Ynison · ${device}`, status: paused ? "paused" : "playing", position: duration ? Math.min(position, duration) : position, duration, rate, observedAt: now, current: true };
}
