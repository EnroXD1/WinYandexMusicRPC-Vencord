/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface MediaSession {
    source: string;
    title: string;
    artist: string;
    album: string;
    status: "playing" | "paused";
    position: number;
    duration: number;
    rate: number;
    observedAt: number;
    current: boolean;
    cover?: string;
    url?: string;
}

export interface MediaSnapshot {
    supported: boolean;
    state: "stopped" | "starting" | "ready" | "error";
    sessions: MediaSession[];
    error?: string;
}

export const DEFAULT_APPLICATION_ID = "1269807014393942046";

export function trackKey(media: MediaSession): string {
    return JSON.stringify([media.source, media.title, media.artist, media.album]);
}

export function selectSession(sessions: MediaSession[], filter: string, preferYandex: boolean, previousSource?: string): MediaSession | undefined {
    const needle = filter.trim().toLocaleLowerCase();
    const candidates = sessions.filter(s => s.title.trim() && (!needle || s.source.toLocaleLowerCase().includes(needle)));
    const priority = (s: MediaSession) => (s.status === "playing" ? 100 : 0)
        + (preferYandex && /yandex|yamusic|яндекс/i.test(s.source) ? 20 : 0)
        + (s.current ? 10 : 0)
        + (s.source === previousSource ? 5 : 0);
    return candidates.sort((a, b) => priority(b) - priority(a))[0];
}

export function playbackTimes(media: MediaSession, now: number): { start: number; end?: number; } | undefined {
    if (media.status !== "playing" || media.rate !== 1 || media.duration <= 0) return;
    const elapsed = Math.max(0, now - media.observedAt) / 1000;
    const position = Math.min(media.duration, Math.max(0, media.position + elapsed));
    if (position >= media.duration) return;
    const start = Math.round(now - position * 1000);
    return { start, end: Math.round(start + media.duration * 1000) };
}

export function normalize(value: string): string {
    return value.normalize("NFKD").toLocaleLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
}

export function matchesArtwork(title: string, artist: string, duration: number, result: { trackName?: string; artistName?: string; trackTimeMillis?: number; }): boolean {
    return Boolean(normalize(artist))
        && normalize(title) === normalize(result.trackName ?? "")
        && normalize(artist) === normalize(result.artistName ?? "")
        && (!duration || !result.trackTimeMillis || Math.abs(duration - result.trackTimeMillis / 1000) <= 10);
}
