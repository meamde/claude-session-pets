// Opt-in read-only check against the running desktop app and Codex account.
const { CodexProvider }=require('../lib/codex');
(async()=>{const p=new CodexProvider();try{await p.list();await new Promise(r=>setTimeout(r,1500));const rows=await p.list();console.log('LIVE_SESSIONS',rows.map(r=>({provider:r.provider,id:r.sessionId,state:r.state,transport:r.transport,task:!!r.task})));const u=await p.usage();console.log('USAGE_WINDOWS',u.windows.map(w=>({minutes:w.minutes,valid:Number.isFinite(w.pct)})));}finally{p.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
