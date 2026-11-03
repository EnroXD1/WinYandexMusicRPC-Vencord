const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const vencord = path.resolve(process.argv[2] || process.cwd());
const { build } = require(path.join(vencord, "node_modules/esbuild"));

async function main() {
    const modules = {
        "@main/utils/constants": "export const SETTINGS_DIR = 'C:/unused-test-settings';",
        "electron": "export const safeStorage = {decryptString: () => 'unit-test-token-only'};",
        "fs": "export const existsSync = () => globalThis.hasToken, readFileSync = () => new Uint8Array(), mkdirSync = () => {}, unlinkSync = () => {}, writeFileSync = () => {};"
    };
    const result = await build({
        entryPoints: [path.resolve(__dirname, "../winYandexMusicRPC.desktop/native.ts")],
        bundle: true, platform: "node", format: "cjs", write: false, nodePaths: [path.join(vencord,"node_modules")],
        plugins: [{name:"mock-token-storage",setup(b){
            b.onResolve({filter:/^(@main\/utils\/constants|electron|fs)$/},args=>({path:args.path,namespace:"mock"}));
            b.onLoad({filter:/.*/,namespace:"mock"},args=>({contents:modules[args.path]}));
        }}]
    });
    async function check(status, body, hasToken=true) {
        const exports={}, calls=[];
        const context={exports,module:{exports},require,Buffer,URL,URLSearchParams,AbortController,AbortSignal,setTimeout,clearTimeout,hasToken,
            process:{platform:"win32",env:{},pid:1,once:()=>{}},
            fetch:async(url,options)=>{calls.push(url);assert.equal(url,"https://api.music.yandex.net/account/status");assert.equal(options.headers.Authorization,"OAuth unit-test-token-only");return{ok:status===200,status,json:async()=>body};}
        };
        vm.runInNewContext(result.outputFiles[0].text,context);
        return{result:await context.module.exports.checkToken(null),calls};
    }
    const accepted=await check(200,{result:{account:{uid:42,login:"private-login"}}});
    assert.equal(accepted.result.ok,true);assert.ok(!JSON.stringify(accepted.result).includes("private-login"));assert.ok(!JSON.stringify(accepted.result).includes("unit-test-token"));
    const expired=await check(401,{});assert.equal(expired.result.ok,false);assert.ok(expired.result.message.includes("401"));
    const scope=await check(403,{});assert.ok(scope.result.message.includes("403"));
    const anonymous=await check(200,{result:{account:{uid:0}}});assert.equal(anonymous.result.ok,false);
    const absent=await check(200,{},false);assert.equal(absent.calls.length,0);
    console.log("PASS: token check distinguishes accepted, expired, forbidden, anonymous and absent tokens without exposing credentials or profile data");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
