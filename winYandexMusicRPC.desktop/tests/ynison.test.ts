/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { currentTrackId, describeYnisonFailure, initialState, normalizeYnisonState, stateHost, ynisonSession, type YnisonState } from "../ynisonProtocol";

const state: YnisonState = {
    player_state: {
        player_queue: { current_playable_index: 0, playable_list: [{ playable_id: "123:456", playable_type: "TRACK" }] },
        status: { paused: false, progress_ms: "30000", duration_ms: "180000", playback_speed: 1, version: { timestamp_ms: "100000", device_id: "phone" } }
    }, active_device_id_optional: "phone", devices: [{ info: { device_id: "phone", title: "My Phone" } }]
};

test("Ynison accepts Yandex state hosts and blocks credential redirects elsewhere", () => {
    assert.equal(stateHost("ynison-back.music.yandex.net"), "wss://ynison-back.music.yandex.net/ynison_state.YnisonStateService/PutYnisonState");
    for (const host of ["evil.test", "yandex.net.evil.test", "a.yandex.net@evil.test", "a.yandex.net:80", "a.yandex.net/path", "a.yandex.net?evil=1"]) assert.throws(() => stateHost(host));
});

test("SDK registration stays passive and excludes fields outside the current protocol", () => {
    const request = initialState("my-device", "request");
    const payload = JSON.stringify(request);
    assert.ok(!payload.includes("canBePlayer"));
    assert.ok(!payload.includes("isCurrentlyActive"));
    assert.ok(!payload.includes("is_shadow"));
    assert.ok(!payload.includes("activityInterceptionType"));
    assert.equal(request.updateFullState.playerState.playerQueue.currentPlayableIndex, -1);
    assert.equal(request.updateFullState.playerState.playerQueue.fromOptional, "");
});

test("camelCase and snake_case state frames identify the same track and playback", () => {
    const camel = {
        playerState: {
            playerQueue: { currentPlayableIndex: 0, playableList: [{ playableId: "123:456", playableType: "TRACK" }] },
            status: { paused: false, progressMs: "30000", durationMs: "180000", playbackSpeed: 1, version: { timestampMs: "100000", deviceId: "phone" } }
        }, activeDeviceIdOptional: "phone", devices: [{ info: { deviceId: "phone", title: "My Phone" } }]
    };
    assert.deepEqual(normalizeYnisonState(camel), normalizeYnisonState(state));
    assert.equal(currentTrackId(normalizeYnisonState(camel)), "123:456");
});

test("request-format errors are not described as token failures", () => {
    const failure = describeYnisonFailure({ grpc_code: 3, http_code: 400, message: "Unknown update request 'PARAMETERS_NOT_SET'", details: { "ynison-error-code": "400030002" } }, "state");
    assert.ok(failure.message.includes("HTTP 400"));
    assert.ok(failure.message.includes("PARAMETERS_NOT_SET"));
    assert.ok(!failure.message.includes("токен"));
    assert.equal(failure.terminal, false);
});

test("only known status codes are exposed; authentication and server cooldown are handled separately", () => {
    const auth = describeYnisonFailure({ grpc_code: "16", http_code: "401", message: "access_token=private-test-secret" }, "redirect");
    assert.ok(auth.message.includes("HTTP 401"));
    assert.ok(!auth.message.includes("private-test-secret"));
    assert.equal(auth.terminal, true);
    const displaced = describeYnisonFailure({ grpc_code: 9, details: { "ynison-error-code": "400090001", "ynison-go-away-for-seconds": "3600" } }, "state");
    assert.equal(displaced.terminal, false);
    assert.equal(displaced.retryAfterMs, 3600000);
});

test("track lookup follows the current queue index, rejecting local and invalid tracks", () => {
    assert.equal(currentTrackId(state), "123:456");
    assert.equal(currentTrackId({ player_state: { player_queue: { playable_list: [{ playable_id: "123", playable_type: "TRACK" }] } } }), "123");
    assert.equal(currentTrackId({ player_state: { player_queue: { current_playable_index: -1, playable_list: [] } } }), undefined);
    assert.equal(currentTrackId({ player_state: { player_queue: { current_playable_index: 0, playable_list: [{ playable_id: "secret", playable_type: "LOCAL_TRACK" }] } } }), undefined);
});

test("phone playback uses server progress, timestamp, active device and pause", () => {
    const track = { title: "Test", artist: "Artist", album: "Album", duration: 180 };
    const playing = ynisonSession(state, track, 102000);
    assert.equal(playing.position, 32);
    assert.equal(playing.source, "Yandex Ynison · My Phone");
    assert.equal(playing.status, "playing");
    const paused = structuredClone(state);
    paused.player_state!.status!.paused = true;
    assert.equal(ynisonSession(paused, track, 102000).position, 30);
    assert.equal(ynisonSession(state, track, 500000).position, 180);
});
