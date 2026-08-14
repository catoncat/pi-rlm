#!/usr/bin/env bun
process.env.PI_RLM_SUBAGENT_TIMEOUT_MS="700";
const {createSubagentHost}=await import(new URL("../src/extension/subagents.ts", import.meta.url).pathname);
const h=createSubagentHost({cwd:process.cwd(),subagentDir:"/tmp/pi-rlm-sub-timeout",defaultModel:"x/y",depth:0,maxDepth:2,spawnCommand:()=>({command:"bash",args:["-lc","sleep 30"]})});
await h.handlers["rlm.run"]({prompt:"x"}); await Bun.sleep(1400); const l=await h.handlers["rlm.list_subagents"]({}); h.killAll(); if(l.subagents?.[0]?.status!=="error"){console.error(l);process.exit(1)} console.log("subagent hard timeout ok"); process.exit(0);