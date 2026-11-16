import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Tournament,fail} from './tournament.mjs';
import {Runner,GroqPlayer,DemoPlayer} from './runner.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DEMO_TOKEN='local-demo-organizer-token';
function number(env,key,fallback,min,max){const value=Number(env[key]??fallback);if(!Number.isFinite(value)||value<min||value>max)throw Error('Invalid '+key);return value;}
export function configuration(env=process.env,demo=false) {
  const adminToken=demo?DEMO_TOKEN:env.ADMIN_TOKEN;
  if(!adminToken||adminToken.length<24)throw Error('Set ADMIN_TOKEN to a random secret of at least 24 characters.');
  if(!demo&&!env.GROQ_API_KEY)throw Error('Set GROQ_API_KEY, or run npm run demo without a model service.');
  const origins=(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  for(const origin of origins){const url=new URL(origin);if(url.origin!==origin||!['http:','https:'].includes(url.protocol))throw Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins.');}
  return {demo,adminToken,origins,apiKey:env.GROQ_API_KEY,host:env.HOST||'127.0.0.1',port:number(env,'PORT',3000,0,65535),
    dataDir:path.resolve(env.DATA_DIR||path.join(ROOT,demo?'data-demo':'data')),autoStart:env.AUTO_START!=='false',
    countdownSeconds:number(env,'COUNTDOWN_SECONDS',demo?5:15,0,120),matchSeconds:number(env,'MATCH_SECONDS',300,1,1800),
    maxRequests:number(env,'MAX_REQUESTS',2000,1,100000),maxTotalTokens:number(env,'MAX_TOTAL_TOKENS',2000000,1,100000000),model:env.MODEL||'openai/gpt-oss-120b'};
}
function authorized(req,secret) {
  const received=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+secret);
  return received.length===expected.length&&crypto.timingSafeEqual(received,expected);
}
async function body(req) {
  let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>24000)throw fail('Request too large.',413);}
  try {const value=JSON.parse(raw||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}catch{throw fail('Invalid JSON.');}
}
export function createApp(config,{player}={}) {
  const tournament=new Tournament(config);
  const runner=new Runner(tournament,player||(config.demo?new DemoPlayer():new GroqPlayer({apiKey:config.apiKey,model:tournament.state.model})));
  const limits=new Map(),streams=new Set();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const url=new URL(req.url,'http://localhost');
    const origin=req.headers.origin;
    const sameOrigin=origin&&[ 'http://'+req.headers.host,'https://'+req.headers.host].includes(origin);
    const allowed=!origin||sameOrigin||config.origins.includes(origin);
    const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
    try {
      if(url.pathname.startsWith('/api/')) {
        if(!allowed)throw fail('Origin not allowed.',403);
        if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
        if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'});res.end();return;}
        if(req.method==='POST') {
          const now=Date.now(),key=req.socket.remoteAddress;
          for(const [k,v] of limits)if(v.until<now)limits.delete(k);
          const entry=limits.get(key)||{count:0,until:now+60000};entry.count++;limits.set(key,entry);
          if(entry.count>90)throw fail('Too many requests. Try again in a minute.',429);
          if(!req.headers['content-type']?.startsWith('application/json'))throw fail('Content-Type must be application/json.',415);
        }
        if(url.pathname==='/api/health'&&req.method==='GET'){json({ok:true,demo:config.demo});return;}
        if(url.pathname==='/api/state'&&req.method==='GET'){json(tournament.publicState());return;}
        if(url.pathname==='/api/events'&&req.method==='GET') {
          if(streams.size>=200)throw fail('Spectator capacity reached. Use refresh.',503);
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
          const send=state=>res.write('data: '+JSON.stringify(state)+'\n\n');send(tournament.publicState());streams.add(res);
          const unsubscribe=tournament.subscribe(send),heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
          res.on('close',()=>{clearInterval(heartbeat);unsubscribe();streams.delete(res);});return;
        }
        if(url.pathname==='/api/submit'&&req.method==='POST'){json(tournament.submit(await body(req)));return;}
        if(url.pathname.startsWith('/api/admin')) {
          if(!authorized(req,config.adminToken))throw fail('Invalid organizer token.',401);
          if(url.pathname==='/api/admin'&&req.method==='GET'){json(tournament.adminState());return;}
          if(req.method==='POST') {
            const data=await body(req);
            switch(url.pathname) {
              case '/api/admin/start':tournament.beginCountdown();break;
              case '/api/admin/pause':tournament.pause();break;
              case '/api/admin/resume':tournament.resume();break;
              case '/api/admin/reset':
                if(data.confirm!==tournament.state.id)throw fail('Confirm the current event ID to archive and reset.');
                if(runner.active.size)throw fail('Wait for in-flight moves to settle before resetting.',409);
                tournament.reset();break;
              case '/api/admin/demo-fill':
                if(!config.demo)throw fail('Demo action unavailable.',404);
                for(const [i,t] of tournament.state.teams.entries())if(!t.ready)tournament.submit({code:t.code,name:['Neon Fleet','Blue Horizon','Red Tide','Deep Signal','Night Watch','Ghost Ships'][i],strategy:'Search a checkerboard pattern, then investigate adjacent hits.'});break;
              default:throw fail('Not found.',404);
            }
            json(tournament.adminState());return;
          }
        }
        throw fail('Not found.',404);
      }
      if(req.method!=='GET'&&req.method!=='HEAD')throw fail('Method not allowed.',405);
      const relative=decodeURIComponent(url.pathname==='/'?'/tournament.html':url.pathname);
      const target=path.resolve(ROOT,'dist','.'+relative),base=path.resolve(ROOT,'dist');
      if(!target.startsWith(base+path.sep))throw fail('Not found.',404);
      if(!fs.existsSync(target)||!fs.statSync(target).isFile())throw fail('Not found.',404);
      const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.txt':'text/plain','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
      res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-cache'});
      if(req.method==='HEAD')res.end();else fs.createReadStream(target).pipe(res);
    } catch(error){if(!res.headersSent)json({error:error.status?error.message:'Internal server error.'},error.status||500);else res.end();if(!error.status)console.error(error);}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return {server,tournament,runner,async close(){await runner.stop();for(const res of streams)res.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const config=configuration(process.env,process.argv.includes('--demo'));
    const app=createApp(config);
    app.server.listen(config.port,config.host,()=>{
      app.runner.start();console.log('Battleship '+(config.demo?'DEMO (no AI calls)':'LIVE')+' listening on port '+app.server.address().port);
      if(config.demo)console.log('Local organizer token: '+DEMO_TOKEN);
    });
    for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>app.close().then(()=>process.exit(0)));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
