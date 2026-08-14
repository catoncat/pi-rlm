#!/usr/bin/env bun
// Verifies the three host-side hard rails. These are passive timers in the pi
// process: they hold regardless of what the model writes, which is the whole
// point — the prompt-side doctrine was dropped so upstream owns model guidance.
import {readFileSync,existsSync} from "node:fs";
import {join} from "node:path";
const ROOT=new URL("..", import.meta.url).pathname; // fork 仓库根目录
for(const [rel,n] of [["src/engine/index.ts","CellTimeoutError"],["src/extension/pi-tools.ts","defaultBashTimeoutSeconds"],["src/extension/subagents.ts","PI_RLM_SUBAGENT_TIMEOUT_MS"],["src/extension/index.ts","await lifecycle.discard();"]]) { const p=join(ROOT,rel); if(!existsSync(p)||!readFileSync(p,"utf8").includes(n)){console.error("missing",n,"in",rel);process.exit(1)} }
// The dropped halves must stay dropped: a stale rlm.wait reference in the
// timeout message would advertise an API the guest no longer has.
for(const [rel,n] of [["src/engine/guest.ts","async wait("],["src/extension/prompt.ts","rlm.wait"],["src/engine/index.ts","rlm.wait"]]) { const p=join(ROOT,rel); if(existsSync(p)&&readFileSync(p,"utf8").includes(n)){console.error("unexpected leftover",n,"in",rel);process.exit(1)} }
console.log("0 source contract ok (rails present, rlm.wait fully removed)");
const {EngineManager}=await import(join(ROOT,"src/engine/index.ts"));

// A: a synchronous infinite loop must return an error and kill its guest.
// Cooperative abort cannot interrupt this, so it proves the killSync path.
process.env.PI_RLM_CELL_TIMEOUT_MS="1200";
{
 const e=new EngineManager({cwd:process.cwd()}); const pid=e.child?.pid; const t=Date.now(); const r=await e.execute("while(true){}"); const ms=Date.now()-t;
 await e.dispose().catch(()=>{});
 if(r.status!=="error"||r.error?.name!=="CellTimeoutError"||ms>5000){console.error("A failed",ms,r);process.exit(1)}
 // The guest must actually be gone, not just reported as failed: a surviving
 // guest would keep burning a core after the cell "ended".
 await new Promise(s=>setTimeout(s,600));
 let alive=false; try{ if(pid){process.kill(pid,0); alive=true;} }catch{}
 if(alive){ try{process.kill(pid,9)}catch{}; console.error("A failed: guest survived timeout",pid); process.exit(1); }
 console.log("A sync-loop timeout",ms,"ms; guest killed");
}

// B: source-level contract for mounted bash default (runtime module uses pi's peer alias).
// pi's own bash-timeout extension hooks tool_call, which the RLM bridge never
// takes, so without this injection bridged bash has no default deadline at all.
{
 const text=readFileSync(join(ROOT,"src/extension/pi-tools.ts"),"utf8");
 if(!text.includes('if (name === "bash")')||!text.includes('args.timeout = defaultBashTimeoutSeconds')){console.error("B failed: injection missing");process.exit(1)}
 console.log("B bash default timeout injection present");
}

// C: the real hang shape — an async poll loop over a child that never settles.
// This is what upstream's prompt teaches, and it must self-heal with nobody
// present to press Esc. Async means the guest stays responsive, so this
// exercises the cooperative-abort path rather than killSync.
process.env.PI_RLM_CELL_TIMEOUT_MS="2000";
{
 const handlers={"rlm.run":async()=>({rlm_child_id:"c1",name:"stuck",output_file:"/tmp/never"}),"rlm.list_subagents":async()=>({subagents:[{rlm_child_id:"c1",name:"stuck",status:"running",output_file:"/tmp/never"}]})};
 const code="const h=await rlm.run('x'); let s='running'; while(s==='running'){ await Bun.sleep(200); s=(await rlm.listSubagents()).subagents[0].status; } 'never reached'";
 const e=new EngineManager({cwd:process.cwd(),hostHandlers:handlers}); const t=Date.now(); const r=await e.execute(code); const ms=Date.now()-t;
 await e.dispose().catch(()=>{});
 if(r.status!=="error"||r.error?.name!=="CellTimeoutError"||ms>6000){console.error("C failed",ms,r);process.exit(1)}
 console.log("C unattended poll loop self-healed",ms,"ms");
}

// D: no signal, no user — the unattended case the whole patch exists for.
// Racing against a longer sleep distinguishes "timed out" from "still hanging".
{
 const e=new EngineManager({cwd:process.cwd()});
 const t=Date.now();
 const r=await Promise.race([e.execute("await new Promise(()=>{})"),new Promise(s=>setTimeout(()=>s({status:"STILL-HANGING"}),8000))]);
 const ms=Date.now()-t;
 await e.dispose().catch(()=>{});
 if(r.status!=="error"||r.error?.name!=="CellTimeoutError"){console.error("D failed",ms,r);process.exit(1)}
 console.log("D unattended never-resolving await self-healed",ms,"ms");
}
console.log("ALL OK"); process.exit(0);
