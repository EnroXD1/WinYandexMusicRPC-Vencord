const { build } = require(require("node:path").resolve(process.argv[2] || process.cwd(), "node_modules/esbuild"));
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");

async function main() {
    const result = await build({
        entryPoints: [path.resolve(__dirname, "../winYandexMusicRPC.desktop/ynison.ts")],
        bundle: true, format: "cjs", platform: "node", write: false,
        plugins: [{name:"fake-ws", setup(b) {
            b.onResolve({filter:/^ws$/}, () => ({path:"ws", namespace:"mock"}));
            b.onLoad({filter:/.*/, namespace:"mock"}, () => ({contents:"export default globalThis.MockSocket;"}));
        }}]
    });
    const code = result.outputFiles[0].text;
    const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
    const phoneState = {
        player_state:{player_queue:{current_playable_index:0,playable_list:[{playable_id:"123:456",playable_type:"TRACK"}]},
            status:{paused:false,progress_ms:"10000",duration_ms:"180000",playback_speed:1,version:{timestamp_ms:"98000",device_id:"phone"}}},
        devices:[{info:{device_id:"phone",title:"Phone"}}],active_device_id_optional:"phone"
    };
    function harness(options={}) {
        const calls=[], requests=[], timers=new Map();
        const frames = options.frames || [{host:"ynison-back.music.yandex.net",redirect_ticket:"ticket",session_id:"123"},phoneState];
        let timerId=0;
        const exports={};
        const context={exports,module:{exports},require,URL,URLSearchParams,AbortController,AbortSignal,Buffer,console,
            Date:class extends Date { static now(){return 100000;} },
            setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
            fetch:async (url,init)=>{ requests.push({url,init});if(options.fetch)return options.fetch(url,init);return {ok:true,json:async()=>({result:[{title:"Song",artists:[{name:"Artist"}],albums:[{id:456,title:"Album"}],durationMs:180000,coverUri:"avatars.yandex.net/get-music-content/abc/%%"}]})}; },
            MockSocket:class extends EventEmitter {
                constructor(url,protocols,config){super();this.closed=false;calls.push({url,protocols,config,socket:this});queueMicrotask(()=>{if(this.closed)return;if(options.httpStatus){this.emit("unexpected-response",{}, {statusCode:options.httpStatus,resume(){}});return;}this.emit("open");if(this.closed)return;const frame=frames.shift();for(const part of (Array.isArray(frame)?frame:[frame]))if(!this.closed)this.emit("message",Buffer.from(JSON.stringify(part)),false);});}
                send(message){this.sent=JSON.parse(message);const state=this.sent.updateFullState;if(!state?.playerState||!state.device||Object.hasOwn(state.device,"is_shadow")){this.emit("message",Buffer.from(JSON.stringify({error:{grpc_code:3,http_code:400,message:"Unknown update request 'PARAMETERS_NOT_SET'",details:{"ynison-error-code":"400030002"}}})),false);}}
                terminate(){this.closed=true;this.emit("close");}
            }
        };
        vm.runInNewContext(code,context);
        const reader=context.module.exports.createYnisonReader(async()=>options.noToken ? null : "test-token-for-unit-tests-only");
        return {reader,calls,requests,timers};
    }
    const success=harness();success.reader.start();await flush();
    const ready=success.reader.getSnapshot();
    assert.equal(ready.state,"ready");
    assert.equal(ready.sessions[0].title,"Song");
    assert.equal(ready.sessions[0].position,12);
    assert.equal(ready.sessions[0].url,"https://music.yandex.ru/album/456/track/123");
    assert.equal(ready.sessions[0].cover,"https://avatars.yandex.net/get-music-content/abc/512x512");
    assert.equal(success.calls.length,2);
    assert.ok(success.calls.every(c=>c.socket.closed));
    assert.equal(success.calls[1].socket.sent.updateFullState.device.capabilities.canBePlayer,undefined);
    assert.equal(success.requests[0].init.headers.Authorization,"OAuth test-token-for-unit-tests-only");
    assert.ok(!JSON.stringify(ready).includes("test-token"));
    success.reader.stop();assert.equal(success.timers.size,0);
    console.log("PASS: redirect, shadow registration, metadata, official cover/link, socket cleanup and credential isolation");

    const missing=harness({noToken:true});missing.reader.start();await flush();
    assert.equal(missing.reader.getSnapshot().state,"error");assert.equal(missing.calls.length,0);missing.reader.stop();
    console.log("PASS: missing token does not open a connection");

    const malicious=harness({frames:[{host:"evil.example",redirect_ticket:"ticket",session_id:"123"}]});malicious.reader.start();await flush();
    assert.equal(malicious.reader.getSnapshot().state,"error");assert.equal(malicious.calls.length,1);assert.equal(malicious.requests.length,0);malicious.reader.stop();
    console.log("PASS: untrusted redirect never receives the token");

    const rejected=harness({frames:[{error:{message:"private details should never be logged"}}]});rejected.reader.start();await flush();
    assert.equal(rejected.reader.getSnapshot().state,"error");assert.ok(!JSON.stringify(rejected.reader.getSnapshot()).includes("private details"));rejected.reader.stop();
    console.log("PASS: server errors are sanitized");

    const aborted=harness({fetch:(_url,init)=>new Promise((_resolve,reject)=>{init.signal.addEventListener("abort",()=>reject(new Error("aborted")));})});aborted.reader.start();await flush();
    assert.equal(aborted.requests.length,1);aborted.reader.stop();await flush();assert.equal(aborted.reader.getSnapshot().state,"stopped");assert.equal(aborted.timers.size,0);
    console.log("PASS: stopping aborts metadata loading and prevents reconnection");

    const params=harness({frames:[{host:"ynison-back.music.yandex.net",redirect_ticket:"ticket",session_id:"123"},{error:{http_code:400,grpc_code:3,message:"Unknown update request 'PARAMETERS_NOT_SET'",details:{"ynison-error-code":"400030002"}}}]});params.reader.start();await flush();
    assert.ok(params.reader.getSnapshot().error.includes("PARAMETERS_NOT_SET"));assert.ok(!params.reader.getSnapshot().error.includes("токен"));params.reader.stop();
    console.log("PASS: protocol rejection is reported as a protocol error, not an expired token");

    const auth=harness({frames:[{error:{http_code:401,grpc_code:16,message:"private authorization details"}}]});auth.reader.start();await flush();
    assert.ok(auth.reader.getSnapshot().error.includes("HTTP 401"));assert.equal(auth.timers.size,0);auth.reader.stop();
    const handshake=harness({httpStatus:403});handshake.reader.start();await flush();assert.ok(handshake.reader.getSnapshot().error.includes("HTTP 403"));assert.equal(handshake.timers.size,0);handshake.reader.stop();
    console.log("PASS: JSON and HTTP authorization rejections stop automatic token retries");

    const camelPhone={playerState:{playerQueue:{playableList:[{playableId:"123:456",playableType:"TRACK"}]},status:{paused:false,progressMs:"10000",durationMs:"180000",playbackSpeed:1,version:{timestampMs:"98000",deviceId:"phone"}}},devices:[{info:{deviceId:"phone",title:"Phone"}}],activeDeviceIdOptional:"phone"};
    const compatible=harness({frames:[{host:"ynison-back.music.yandex.net",redirectTicket:"ticket",sessionId:"123"},[{rid:"ack"},camelPhone]]});compatible.reader.start();await flush();assert.equal(compatible.reader.getSnapshot().state,"ready");assert.equal(compatible.reader.getSnapshot().sessions[0].position,12);compatible.reader.stop();
    console.log("PASS: camelCase frames and separate registration acknowledgements are supported");
}
main().catch(error=>{console.error(error);process.exitCode=1;});

