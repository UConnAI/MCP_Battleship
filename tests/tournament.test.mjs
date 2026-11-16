import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable,Writable} from 'node:stream';
import {Tournament} from '../server/tournament.mjs';
import {createApp,configuration} from '../server/index.mjs';
import {Runner,DemoPlayer,GroqPlayer,modelTool,ProviderError} from '../server/runner.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'battleship-test-'));
const config=()=>({...configuration({},true),dataDir:temp(),countdownSeconds:0});
const fill=t=>t.state.teams.forEach((team,i)=>t.submit({code:team.code,name:'Team '+i,strategy:'Private strategy '+i+' checkerboard'}));
const fleets=[{size:'big',start:'A1',direction:'horizontal'},{size:'medium',start:'C1',direction:'horizontal'},{size:'small',start:'E1',direction:'horizontal'}];
const call=(t,g,seat,name,args={})=>t.rpc({id:1,method:'tools/call',params:{name,arguments:{...args,match_id:g.match.id,seat_token:g.tokens[seat]}}}).result;
async function until(predicate,timeout=10000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw Error('Timed out');await new Promise(r=>setTimeout(r,20));}}

test('six unique team codes lock once and draw a bracket with exactly two byes',()=>{
  const t=new Tournament(config());
  assert.throws(()=>t.submit({code:'fake',name:'x',strategy:'long enough strategy'}),/Invalid team/);
  const first=t.state.teams[0];t.submit({code:first.code,name:'First',strategy:'long enough strategy'});
  t.submit({code:first.code,name:'First updated',strategy:'updated private strategy'});
  assert.equal(t.state.teams.filter(x=>x.ready).length,1);
  assert.throws(()=>t.submit({code:t.state.teams[1].code,name:'First updated',strategy:'long enough strategy'}),/already taken/);
  fill(t);assert.equal(t.state.status,'countdown');assert.equal(t.state.games.length,2);
  assert.equal(new Set([...t.state.byes,...t.state.games.flatMap(g=>[g.A,g.B])]).size,6);
  assert.throws(()=>t.submit({code:first.code,name:'Edit',strategy:'long enough strategy'}),/locked/);
  assert.throws(()=>t.beginCountdown(),/already started/);
});
test('public and opposing views exclude secrets, strategies, reasons and live fleets',()=>{
  const t=new Tournament(config());fill(t);t.advance();const g=t.state.games[0];
  for(const seat of ['A','B'])assert.equal(call(t,g,seat,'place_fleet',{ships:fleets}).isError,false);
  assert.equal(call(t,g,'A','fire',{coordinate:'A1',reason:'SECRET tactical note'}).isError,false);
  const opponent=JSON.parse(call(t,g,'B','get_view').content[0].text);
  assert.equal(opponent.incoming_shots[0].reason,undefined);assert.equal(opponent.final_fleets,undefined);
  const publicText=JSON.stringify(t.publicState());
  for(const secret of [t.state.teams[0].code,g.tokens.A,'Private strategy','SECRET tactical note','your_fleet','"fleets"'])assert.ok(!publicText.includes(secret),secret);
  assert.equal(call(t,g,'A','fire',{coordinate:'A2'}).isError,true);
  call(t,g,'B','fire',{coordinate:'J1'});assert.equal(call(t,g,'A','fire',{coordinate:'A1'}).isError,true);
});
test('deadline adjudication waits for equal turns; restart pauses and preserves state',()=>{
  const c=config(),t=new Tournament(c);fill(t);t.advance();const g=t.state.games[0];
  for(const s of ['A','B'])call(t,g,s,'place_fleet',{ships:fleets});
  call(t,g,'A','fire',{coordinate:'A1'});assert.equal(t.adjudicate(g),false);
  call(t,g,'B','fire',{coordinate:'J1'});assert.equal(t.adjudicate(g),true);assert.equal(g.winner,g.A);
  const restored=new Tournament(c);assert.equal(restored.state.status,'paused');assert.equal(restored.state.games[0].winner,g.A);
  assert.deepEqual(restored.state.teams,t.state.teams);restored.resume();assert.equal(restored.state.status,'running');
});
test('full six-team event runs parallel pairs, five games and one champion',async()=>{
  const scripted={async decide({tool,privateView}){await new Promise(r=>setTimeout(r,5));return {args:tool==='place_fleet'?{ships:fleets}:{coordinate:['A1','A2','A3','A4','A5','C1','C2','C3','E1','E2'][privateView.your_shots.length]},usage:0};}};
  const t=new Tournament(config()),r=new Runner(t,scripted);let peak=0;
  fill(t);r.start();
  const sample=setInterval(()=>{peak=Math.max(peak,r.active.size);},5);
  try{await until(()=>t.state.status==='finished',20000);assert.equal(t.state.games.length,5);assert.equal(peak,2);assert.ok(t.state.winner);assert.ok(t.state.games.every(g=>g.status==='finished'));assert.deepEqual(t.state.games.map(g=>g.round),[1,1,2,2,3]);assert.ok(t.publicState().games.every(g=>g.fleets));}
  finally{clearInterval(sample);await r.stop();}
});
test('provider failure pauses without awarding a winner',async()=>{
  const t=new Tournament(config()),r=new Runner(t,{async decide(){throw new ProviderError('Service unavailable');}});fill(t);r.start();
  try{await until(()=>t.state.status==='paused');assert.equal(t.state.winner,null);assert.equal(t.state.notice,'Service unavailable');}finally{await r.stop();}
});
test('request budget stops paid work and requires budget increase to resume',async()=>{
  const t=new Tournament({...config(),maxRequests:1}),r=new Runner(t,new DemoPlayer(0));fill(t);r.start();
  try{await until(()=>t.state.status==='paused');assert.equal(t.state.requests,1);assert.throws(()=>t.resume(),/budget exhausted/);}finally{await r.stop();}
});
test('late provider result after pause is discarded and tokens are recorded',async()=>{
  const t=new Tournament(config());fill(t);t.advance();let release;const pending=new Promise(r=>release=r);
  const r=new Runner(t,{async decide(){await pending;return {args:{ships:fleets},usage:50};}});
  const playing=r.play(t.state.games[0]);t.pause();release();await playing;
  assert.equal(t.state.games[0].match.players.A.fleet.length,0);assert.equal(t.state.totalTokens,50);await r.stop();
});
test('Groq adapter forces one tool, strips seat credentials, and handles malformed output',async()=>{
  assert.equal(modelTool('fire').function.parameters.properties.seat_token,undefined);
  let sent;const player=new GroqPlayer({apiKey:'test',model:'test',fetchImpl:async(url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({usage:{total_tokens:22},choices:[{message:{tool_calls:[{function:{name:'fire',arguments:'{"coordinate":"A1"}'}}]}}]})};}});
  const result=await player.decide({privateView:{},strategy:'search',tool:'fire',signal:new AbortController().signal});
  assert.equal(result.args.coordinate,'A1');assert.equal(result.usage,22);assert.equal(sent.tool_choice.function.name,'fire');assert.equal(sent.parallel_tool_calls,false);
  player.fetch=async()=>({ok:true,json:async()=>({choices:[]})});assert.match((await player.decide({privateView:{},strategy:'search',tool:'fire',signal:new AbortController().signal})).error,/exactly one/);
});
// Exercise the actual HTTP request handler without requiring loopback permissions.
function request(app,url,{method='GET',headers={},body=''}={}) {
  return new Promise((resolve,reject)=>{
    const req=Readable.from(body?[Buffer.from(body)]:[]);Object.assign(req,{url,method,headers:{host:'localhost',...headers},socket:{remoteAddress:'127.0.0.1'}});
    const chunks=[];let responseHeaders={},settled=false;
    const res=new Writable({write(chunk,encoding,done){chunks.push(Buffer.from(chunk));done();if(responseHeaders['Content-Type']==='text/event-stream')queueMicrotask(()=>{complete();res.emit('close');});}});
    res.setHeader=(name,value)=>{responseHeaders[name]=value;};
    res.writeHead=(status,extra={})=>{res.statusCode=status;Object.assign(responseHeaders,extra);res.headersSent=true;};
    const complete=()=>{if(settled)return;settled=true;resolve({status:res.statusCode,text:Buffer.concat(chunks).toString(),headers:responseHeaders});};
    res.on('finish',complete);res.on('error',reject);app.server.emit('request',req,res);
  });
}
test('HTTP handlers protect organizer actions, validate origins and stream only public state',async()=>{
  const c=config(),app=createApp(c);
  try {
    assert.equal((await request(app,'/api/admin')).status,401);
    assert.equal((await request(app,'/api/state',{headers:{origin:'https://evil.example'}})).status,403);
    const admin=JSON.parse((await request(app,'/api/admin',{headers:{authorization:'Bearer '+c.adminToken}})).text);assert.equal(admin.codes.length,6);
    const response=await request(app,'/api/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:admin.codes[0].code,name:'Alpha',strategy:'Search the entire board'})});assert.equal(response.status,200);
    const events=await request(app,'/api/events');assert.ok(events.text.startsWith('data: '));assert.ok(!events.text.includes(admin.codes[0].code));
    assert.equal((await request(app,'/tournament.html')).status,200);
    assert.equal((await request(app,'/data-demo/tournament.json')).status,404);
    assert.equal((await request(app,'/api/admin/reset',{method:'POST',headers:{authorization:'Bearer '+c.adminToken,'content-type':'application/json'},body:'{}'})).status,400);
  }finally{await app.close();}
});
test('live configuration requires secrets and rejects wildcard origins',()=>{
  assert.throws(()=>configuration({}),/ADMIN_TOKEN/);
  assert.throws(()=>configuration({ADMIN_TOKEN:'a'.repeat(24)}),/GROQ_API_KEY/);
  assert.throws(()=>configuration({ADMIN_TOKEN:'a'.repeat(24),GROQ_API_KEY:'x',ALLOWED_ORIGINS:'*'}));
});
