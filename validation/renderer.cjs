const { build } = require(require("node:path").resolve(process.argv[2] || process.cwd(), "node_modules/esbuild"));
const vm = require("node:vm");
const assert = require("node:assert/strict");
const path = require("node:path");

const source = {
    "@api/Settings": `export function definePluginSettings(def) { const store = Object.fromEntries(Object.entries(def).map(([k,v]) => [k, v.default ?? v.options?.find(o => o.default)?.value])); globalThis.store = store; return {store}; }`,
    "@components/Button": `export const Button = () => null;`,
    "@components/ErrorBoundary": `export default {wrap: f => f};`,
    "@components/Paragraph": `export const Paragraph = () => null;`,
    "@utils/Logger": `export class Logger { error(...args) { globalThis.errors.push(args); } }`,
    "@utils/types": `export default function definePlugin(p) { globalThis.plugin = p; return p; } export const OptionType = {STRING:1, BOOLEAN:2, NUMBER:3, SELECT:4};`,
    "@vencord/discord-types/enums": `export const ActivityFlags = {INSTANCE:1}, ActivityStatusDisplayType = {NAME:0,STATE:1,DETAILS:2}, ActivityType = {LISTENING:2};`,
    "@webpack/common": `export const React = {createElement: () => null}, TextInput = () => null, useEffect = () => {}, useState = () => [], showToast = () => {}; export const ApplicationAssetUtils = {fetchAssetIds: async (app, keys) => keys.map(k => "asset:" + k)}, FluxDispatcher = {dispatch: event => globalThis.events.push(event)};`
};

async function main() {
    const result = await build({
        entryPoints: [path.resolve(__dirname, "../winYandexMusicRPC.desktop/index.tsx")],
        bundle: true, format: "cjs", platform: "node", write: false,
        plugins: [{name: "mock-vencord", setup(b) {
            b.onResolve({filter: /^@/}, args => {
                if (!(args.path in source)) throw new Error("Unexpected runtime dependency: " + args.path);
                return {path: args.path, namespace: "mock"};
            });
            b.onLoad({filter: /.*/, namespace: "mock"}, args => ({contents: source[args.path], loader: "js"}));
        }}]
    });
    const code = result.outputFiles[0].text;
    const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    function harness() {
        let now = 100000;
        let id = 0;
        const timers = new Map();
        const media = {source: "YandexMusic.exe", title: "Track A", artist: "Artist", album: "Album", status: "playing", position: 30, duration: 180, rate: 1, observedAt: now, current: true};
        const state = {sessions:[media], state:"ready", supported:true};
        const native = {start: async () => {}, stop: async () => {}, getSnapshot: async () => structuredClone(state), findArtwork: async () => null};
        const context = {
            module: {exports:{}}, exports:{}, console, URL, URLSearchParams,
            VencordNative:{pluginHelpers:{WinYandexMusicRPC:native}}, events:[], errors:[],
            Date: class extends Date { static now() { return now; } },
            setTimeout: (fn, delay) => { const key = ++id; timers.set(key, {fn, at:now + delay}); return key; },
            clearTimeout: key => timers.delete(key)
        };
        vm.runInNewContext(code, context);
        return {context, media, state, native,
            async tick(ms) {
                now += ms;
                for (const [key,timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); }
                await flush();
            },
            async start() { context.plugin.start(); await flush(); },
            async stop() { context.plugin.stop(); await flush(); },
            get activity() { return context.events.at(-1)?.activity; }
        };
    }

    const h = harness();
    h.context.store.showCover = false;
    await h.start();
    assert.equal(h.activity.details, "Track A");
    assert.equal(h.activity.type, 2);
    assert.equal(h.activity.timestamps.start, 70000);
    const sent = h.context.events.length;
    await h.tick(1000);
    assert.equal(h.context.events.length, sent, "unchanged playback must not flood Discord");
    h.media.status = "paused";
    await h.tick(1000);
    assert.equal(h.activity.timestamps, undefined);
    assert.ok(h.activity.state.startsWith("⏸"));
    await h.tick(30000);
    assert.equal(h.activity, null, "pause timeout clears status");
    h.media.status = "playing";
    h.media.position = 50;
    h.media.observedAt = 132000;
    await h.tick(1000);
    assert.equal(h.activity.details, "Track A");
    assert.equal(h.activity.timestamps.start, 82000);
    h.state.sessions = [];
    await h.tick(1000);
    assert.equal(h.activity, null, "closing the player clears status");
    await h.stop();
    assert.ok(h.context.events.every(e => e.socketId === "WinYandexMusicRPC"));
    console.log("PASS: publish, deduplicate, pause, timeout, resume, player close, isolated socket");

    const pending = harness();
    let resolveCover;
    pending.native.findArtwork = () => new Promise(resolve => { resolveCover = resolve; });
    await pending.start();
    assert.equal(pending.context.events.length, 0);
    await pending.stop();
    resolveCover(null);
    await flush();
    await pending.tick(10000);
    assert.equal(pending.activity, null);
    assert.ok(pending.context.events.every(e => e.activity === null));
    console.log("PASS: a disabled plugin cannot restore status after delayed artwork");

    const restart = harness();
    let resolveOld;
    restart.native.findArtwork = () => new Promise(resolve => { resolveOld = resolve; });
    await restart.start();
    await restart.stop();
    restart.media.title = "Track B";
    restart.media.position = 10;
    restart.context.store.showCover = false;
    await restart.start();
    assert.equal(restart.activity.details, "Track B");
    resolveOld(null);
    await flush();
    await restart.tick(1000);
    assert.equal(restart.activity.details, "Track B");
    assert.equal(restart.activity.timestamps.start, 90000);
    await restart.stop();
    console.log("PASS: restart ignores a previous generation's pending work");

    const failed = harness();
    failed.state.state = "error";
    failed.state.error = "Reader unavailable";
    failed.state.sessions = [];
    await failed.start();
    assert.equal(failed.activity, null);
    assert.equal(failed.context.errors.length, 1);
    await failed.tick(1000);
    assert.equal(failed.context.errors.length, 1);
    await failed.stop();
    console.log("PASS: reader failure clears status and avoids repeated error notifications");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

