/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { matchesArtwork, type MediaSession, playbackTimes, selectSession, trackKey } from "../media";

const session = (overrides: Partial<MediaSession> = {}): MediaSession => ({
    source: "YandexMusic.exe", title: "Тест", artist: "Артист", album: "Альбом", status: "playing",
    position: 30, duration: 180, rate: 1, observedAt: 100000, current: false, ...overrides
});

test("an actively playing source wins over paused Yandex", () => {
    const paused = session({ status: "paused", current: true });
    const playing = session({ source: "chrome.exe" });
    assert.equal(selectSession([paused, playing], "", true), playing);
});

test("Yandex priority, Windows current session and explicit filter", () => {
    const yandex = session();
    const browser = session({ source: "chrome.exe", current: true });
    assert.equal(selectSession([browser, yandex], "", true), yandex);
    assert.equal(selectSession([yandex, browser], "", false), browser);
    assert.equal(selectSession([yandex, browser], " CHROME ", true), browser);
    assert.equal(selectSession([yandex, browser], "missing", true), undefined);
    assert.equal(selectSession([session({ title: " " })], "", true), undefined);
});

test("position advances from observation time and Discord receives milliseconds", () => {
    assert.deepEqual(playbackTimes(session(), 102000), { start: 70000, end: 250000 });
    assert.deepEqual(playbackTimes(session({ position: -3 }), 100000), { start: 100000, end: 280000 });
});

test("pause, unknown duration, exhausted track and non-unit speed have no misleading timer", () => {
    assert.equal(playbackTimes(session({ status: "paused" }), 102000), undefined);
    assert.equal(playbackTimes(session({ duration: 0 }), 102000), undefined);
    assert.equal(playbackTimes(session({ position: 180 }), 102000), undefined);
    assert.equal(playbackTimes(session({ rate: 1.5 }), 102000), undefined);
});

test("track identities distinguish sources and delimiter characters", () => {
    assert.notEqual(trackKey(session()), trackKey(session({ source: "chrome.exe" })));
    assert.notEqual(trackKey(session({ title: "a|b", artist: "c" })), trackKey(session({ title: "a", artist: "b|c" })));
});

test("artwork requires matching artist/title and a compatible duration", () => {
    assert.equal(matchesArtwork("Héllo!", "Artist", 180, { trackName: "Hello", artistName: "ARTIST", trackTimeMillis: 181000 }), true);
    assert.equal(matchesArtwork("Hello", "Artist", 180, { trackName: "Hello (Live)", artistName: "Artist" }), false);
    assert.equal(matchesArtwork("Hello", "Artist", 180, { trackName: "Hello", artistName: "Other" }), false);
    assert.equal(matchesArtwork("Hello", "Artist", 180, { trackName: "Hello", artistName: "Artist", trackTimeMillis: 240000 }), false);
    assert.equal(matchesArtwork("Hello", "", 180, { trackName: "Hello", artistName: "" }), false);
});
