'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Exercise the installed CLI boundary, including validation, fallback and launch.
async function runLauncher(t, scenario, args = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompt3-launch-'));
  const log = path.join(dir, 'launches.jsonl');
  const fake = path.join(dir, 'omp');
  fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('omp/18.12.6'); process.exit(0); }
if (args[0] === 'models') { console.log('[]'); process.exit(0); }
fs.appendFileSync(process.env.LAUNCH_LOG, JSON.stringify(args)+'\\n');
fs.appendFileSync(process.env.LAUNCH_LOG+'.pids',process.pid+'\\n');
const idx=args.indexOf('--tools');
const list=idx<0 ? args.find(a=>a.startsWith('--tools='))?.slice(8) : args[idx+1];
const names=list===undefined ? [] : list.split(',');
const scenario=process.env.SCENARIO;
const bad=scenario==='all' ? names : names.filter(n=>n==='missing'||(['single','slow','late-rejection','plural'].includes(scenario)&&n==='lsp')||(scenario==='plural'&&n==='find'));
if (bad.length) {
 const reject=()=>{console.error('Error: Unknown tool'+(bad.length===1?'':'s')+' in --tools: '+bad.join(', ')+'.'); process.exit(2);};
 if(scenario==='late-rejection') {setTimeout(reject,1100); return;}
 reject();
}
if (process.env.SCENARIO==='failure') { console.error('Unrelated startup failure'); process.exit(2); }
if (process.env.SCENARIO==='early-exit') process.exit(0);
if (scenario==='interrupt') {setInterval(()=>{},1000); return;}
setTimeout(()=>console.log(JSON.stringify({type:'ready',protocolVersion:1})), process.env.SCENARIO==='slow' ? 1100 : 10);
setInterval(()=>{},1000);
`);
  fs.chmodSync(fake, scenario==='non-executable' ? 0o644 : 0o755);
  const child = spawn(process.execPath, [path.resolve('bin/omp-t3'), '--mode', 'rpc', ...args], {
    detached: true,
    env: {...process.env, OMP_PATH: fake, OMPT3_DELEGATE_TASKS: '1', OMPT3_MAX_SUBAGENTS:'',
      LAUNCH_LOG:log, SCENARIO:scenario, ...env},
    stdio: ['pipe','pipe','pipe']
  });
  let stdout='', stderr='';
  child.stdout.on('data', d=>{stdout+=d;});
  child.stderr.on('data', d=>{stderr+=d;});
  const exited = new Promise(resolve=>child.once('close', code=>resolve(code)));
  const killOwnGroup = ()=>{try {process.kill(-child.pid,'SIGKILL');} catch(err) {if(err.code!=='ESRCH') throw err;}};
  t.after(async()=>{killOwnGroup(); await exited; fs.rmSync(dir,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Launcher timed out: '+stderr)),7000);
    if (scenario==='interrupt') setTimeout(()=>child.kill('SIGTERM'),500);
    const check=()=>{if(stdout.includes('"type":"ready"')){clearTimeout(timer);resolve();}};
    child.stdout.on('data',check);
    child.once('close',()=>{clearTimeout(timer);resolve();});
  });
  killOwnGroup();
  await exited;
  const launches=fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse) : [];
  const pids=fs.existsSync(log+'.pids') ? fs.readFileSync(log+'.pids','utf8').trim().split('\n').map(Number) : [];
  return {stdout,stderr,launches,pids};
}

function tools(args) {const idx=args.indexOf('--tools'); return idx<0 ? undefined : args[idx+1];}

test('launcher prunes one rejected built-in and preserves user prompt on launch', async t=>{
  const result=await runLauncher(t,'single',['--append-system-prompt','USER RULE']);
  assert.match(result.stdout,/"type":"ready"/);
  const final=result.launches.at(-1);
  assert.ok(tools(final), 'enforced list must survive singular rejection');
  assert.ok(!tools(final).split(',').includes('lsp'));
  assert.ok(!tools(final).split(',').includes('task'));
  assert.ok(final.some(a=>a.includes('USER RULE')));
  assert.doesNotMatch(result.stderr,/degraded/);
});

test('launcher falls back to original user arguments when every built-in is rejected', async t=>{
  const result=await runLauncher(t,'all',['--append-system-prompt=USER RULE']);
  assert.match(result.stdout,/"type":"ready"/);
  const final=result.launches.at(-1);
  assert.equal(tools(final),undefined,'empty enforced list must never launch');
  assert.ok(final.includes('--append-system-prompt=USER RULE'));
  assert.ok(!final.some(a=>a.includes('Delegation policy')));
  assert.match(result.stderr,/degraded/);
});

for (const flags of [['--tools','read,missing'],['--tools=read,missing']]) {
 test('launcher preserves explicit tool flags without probing '+flags[0], async t=>{
  const result=await runLauncher(t,'single',[...flags,'--append-system-prompt','USER RULE']);
  assert.equal(result.launches.length,1,'user-selected tools must not be probed or pruned');
  assert.ok(flags.every(flag=>result.launches[0].includes(flag)));
  assert.ok(result.launches[0].includes('USER RULE'));
  assert.doesNotMatch(result.stderr,/degraded/);
 });
}

test('launcher waits for ready before launching when validation takes more than 900ms',async t=>{
 const result=await runLauncher(t,'slow');
 assert.match(result.stdout,/"type":"ready"/);
 assert.equal(result.launches.length,3,'one rejected probe, one ready probe, one launch');
 assert.ok(tools(result.launches.at(-1)));
});

test('launcher treats exit zero without ready as failed validation',async t=>{
 const result=await runLauncher(t,'early-exit');
 assert.match(result.stderr,/degraded/);
 assert.equal(tools(result.launches.at(-1)),undefined);
});


test('launcher catches a validation failure arriving after the old 900ms cutoff', async t=>{
 const result=await runLauncher(t,'late-rejection');
 assert.match(result.stdout,/"type":"ready"/);
 assert.equal(result.launches.length,3);
 assert.ok(!tools(result.launches.at(-1)).split(',').includes('lsp'));
});

test('launcher prunes multiple rejected built-ins', async t=>{
 const result=await runLauncher(t,'plural');
 assert.match(result.stdout,/"type":"ready"/);
 const final=tools(result.launches.at(-1)).split(',');
 assert.ok(!final.includes('lsp')&&!final.includes('find'));
 assert.doesNotMatch(result.stderr,/degraded/);
});

test('launcher reports an unspawnable probe without an unhandled error event',async t=>{
 const result=await runLauncher(t,'non-executable');
 assert.match(result.stderr,/degraded/);
 assert.match(result.stderr,/Failed to spawn omp child process/);
 assert.doesNotMatch(result.stderr,/Unhandled 'error' event/);
});


test('interrupting the launcher during validation terminates only its probe',async t=>{
 const result=await runLauncher(t,'interrupt');
 assert.equal(result.launches.length,1,'interrupted validation must not start a real session');
 assert.equal(result.pids.length,1);
 assert.throws(()=>process.kill(result.pids[0],0),{code:'ESRCH'},'the owned probe must be gone');
});
