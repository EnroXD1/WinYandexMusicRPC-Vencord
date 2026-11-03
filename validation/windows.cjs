const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const assert = require("node:assert/strict");
const vencord = path.resolve(process.argv[2] || process.cwd());
const { build } = require(path.join(vencord, "node_modules/esbuild"));

async function main() {
    const result = await build({
        entryPoints: [path.resolve(__dirname, "../winYandexMusicRPC.desktop/native.ts")],
        bundle: true, platform: "node", format: "cjs", write: false,
        nodePaths: [path.join(vencord, "node_modules")],
        plugins: [{ name: "mock-electron-only", setup(b) {
            b.onResolve({ filter: /^(@main\/utils\/constants|electron)$/ }, args => ({ path: args.path, namespace: "mock" }));
            b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "electron"
                ? "export const safeStorage = {isEncryptionAvailable(){throw new Error('Windows mode should not access credentials')}};"
                : "export const SETTINGS_DIR = " + JSON.stringify(path.join(os.tmpdir(), "wymrpc-unused-test-credentials")) + ";" }));
        }}]
    });
    const exports = {};
    const context = { exports, module: { exports }, require, process, Buffer, console, URL, URLSearchParams, AbortController, AbortSignal, fetch, setTimeout, clearTimeout };
    vm.runInNewContext(result.outputFiles[0].text, context);
    const native = context.module.exports;
    try {
        native.start(null, "windows");
        for (let i = 0; i < 20; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const snapshot = native.getSnapshot(null);
            if (snapshot.state === "error") throw new Error(snapshot.error);
            if (snapshot.state === "ready") {
                console.log(JSON.stringify({ state: snapshot.state, sessions: snapshot.sessions.length, sources: snapshot.sessions.map(s => s.source) }));
                return;
            }
        }
        throw new Error("Windows reader did not become ready");
    } finally {
        native.stop(null);
        assert.equal(native.getSnapshot(null).state, "stopped");
        console.log("PASS: Windows reader stopped");
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
