import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createMatch, move, view, toolList} from '../arena/referee.mjs';

export const shuffle = items => {
  const out = [...items];
  for (let i=out.length-1;i>0;i--) { const j=crypto.randomInt(i+1); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
};
export const fail = (message, status=400) => Object.assign(new Error(message), {status});
export class Tournament {
  constructor({dataDir, demo=false, autoStart=true, countdownSeconds=15, matchSeconds=300, maxRequests=2000, maxTotalTokens=2000000, model='openai/gpt-oss-120b'}) {
    this.options={demo,autoStart,countdownSeconds,matchSeconds,maxRequests,maxTotalTokens,model};
    this.file=path.join(dataDir,'tournament.json');
    fs.mkdirSync(dataDir,{recursive:true});
    if(fs.existsSync(this.file)) {
      this.state=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(this.state.demo!==demo) throw Error('Existing event has a different mode. Use a separate DATA_DIR.');
      if(['running','countdown'].includes(this.state.status)) {
        this.state.status='paused'; this.state.notice='Server restarted. Organizer must resume the event.';
      }
    } else this.state=this.fresh();
    this.listeners=new Set(); this.save();
  }
  fresh() {
    return {id:crypto.randomUUID(),demo:this.options.demo,model:this.options.model,status:'lobby',revision:0,createdAt:new Date().toISOString(),teams:Array.from({length:6},(_,i)=>({id:'team-'+(i+1),code:crypto.randomBytes(12).toString('hex'),name:'',strategy:'',ready:false})),games:[],round:0,winner:null,notice:'',requests:0,totalTokens:0};
  }
  save() {
    this.state.revision++;
    fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.state),{mode:0o600});
    fs.renameSync(this.file+'.tmp',this.file);
    for(const fn of this.listeners||[]) fn(this.publicState());
  }
  subscribe(fn) { this.listeners.add(fn); return ()=>this.listeners.delete(fn); }
  submit({code,name,strategy}) {
    if(this.state.status!=='lobby') throw fail('Submissions are locked.',409);
    const team=this.state.teams.find(t=>t.code===code);
    if(!team) throw fail('Invalid team code.',403);
    if(typeof name!=='string'||!name.trim()||name.trim().length>40) throw fail('Use a team name of 1–40 characters.');
    if(typeof strategy!=='string'||strategy.trim().length<10||strategy.length>6000) throw fail('Strategy must contain 10–6000 characters.');
    if(this.state.teams.some(t=>t.id!==team.id&&t.ready&&t.name.toLowerCase()===name.trim().toLowerCase())) throw fail('That team name is already taken.',409);
    Object.assign(team,{name:name.trim(),strategy:strategy.trim(),ready:true});
    if(this.options.autoStart&&this.state.teams.every(t=>t.ready)) this.beginCountdown();
    else this.save();
    return {teamId:team.id,locked:this.state.status!=='lobby'};
  }
  beginCountdown() {
    if(!this.state.teams.every(t=>t.ready)) throw fail('All six teams must submit first.',409);
    if(this.state.status!=='lobby') throw fail('Event already started.',409);
    const ids=shuffle(this.state.teams.map(t=>t.id));
    this.state.byes=ids.slice(0,2);
    this.state.games=[this.game('q1',1,ids[2],ids[3]),this.game('q2',1,ids[4],ids[5])];
    this.state.status='countdown';this.state.startsAt=Date.now()+this.options.countdownSeconds*1000;
    this.state.notice='Entries locked. Two byes assigned by random draw.';this.save();
  }
  game(id,round,a,b) {
    const [A,B]=shuffle([a,b]);
    const teamA=this.state.teams.find(t=>t.id===A),teamB=this.state.teams.find(t=>t.id===B);
    const match=createMatch({A:teamA.strategy,B:teamB.strategy});
    match.players.A.name=teamA.name;match.players.B.name=teamB.name;
    return {id,round,A,B,match,status:'pending',winner:null,elapsedMs:0,tieSeat:crypto.randomInt(2)?'A':'B',tokens:{A:crypto.randomUUID(),B:crypto.randomUUID()}};
  }
  advance() {
    if(this.state.status==='countdown'&&Date.now()>=this.state.startsAt) {this.state.status='running';this.state.round=1;this.state.notice='Opening round underway.';this.save();}
    if(this.state.status!=='running')return;
    const current=this.state.games.filter(g=>g.round===this.state.round);
    if(!current.length||!current.every(g=>g.status==='finished'))return;
    if(this.state.round===1) {
      this.state.games.push(this.game('s1',2,this.state.byes[0],current[0].winner),this.game('s2',2,this.state.byes[1],current[1].winner));
      this.state.round=2;this.state.notice='Semifinals underway.';
    } else if(this.state.round===2) {
      this.state.games.push(this.game('final',3,current[0].winner,current[1].winner));this.state.round=3;this.state.notice='Championship match underway.';
    } else {this.state.status='finished';this.state.winner=current[0].winner;this.state.notice='Tournament complete.';}
    this.save();
  }
  pause(message='Paused by organizer.') {
    if(!['running','countdown'].includes(this.state.status))throw fail('No active event to pause.',409);
    this.state.status='paused';this.state.notice=message;this.save();
  }
  resume() {
    if(this.state.status!=='paused')throw fail('Event is not paused.',409);
    if(this.state.requests>=this.options.maxRequests||this.state.totalTokens>=this.options.maxTotalTokens)throw fail('Usage budget exhausted. Increase the server limit before resuming.',409);
    this.state.status=this.state.round?'running':'countdown';this.state.startsAt=Date.now()+this.options.countdownSeconds*1000;this.state.notice='Event resumed.';this.save();
  }
  reset() {
    if(['running','countdown'].includes(this.state.status))throw fail('Pause the event before resetting.',409);
    const archive=path.join(path.dirname(this.file),'archive');fs.mkdirSync(archive,{recursive:true});
    fs.copyFileSync(this.file,path.join(archive,this.state.id+'.json'));
    this.state=this.fresh();this.save();
  }
  // One trusted MCP dispatcher: models never choose seat credentials or read files.
  rpc(request) {
    const {id,method,params={}}=request;
    if(method==='initialize')return {jsonrpc:'2.0',id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Battleship tournament referee',version:'2.0.0'}}};
    if(method==='tools/list')return {jsonrpc:'2.0',id,result:{tools:toolList.filter(t=>t.name!=='wait_turn')}};
    if(method!=='tools/call')return {jsonrpc:'2.0',id,error:{code:-32601,message:'Unknown method'}};
    try {
      const args=params.arguments||{};
      const game=this.state.games.find(g=>g.match.id===args.match_id);
      const seat=game&&['A','B'].find(s=>game.tokens[s]===args.seat_token);
      if(!seat)throw Error('Invalid match or seat.');
      if(params.name!=='get_view'&&this.state.status!=='running')throw Error('Tournament is not running.');
      const value=move(game.match,seat,params.name,args);
      if(params.name!=='get_view') {
        game.status=game.match.status==='finished'?'finished':'playing';
        if(game.match.status==='finished'){game.winner=game[game.match.winner];game.resultReason='Fleet destroyed';}
        this.save();
      }
      return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(value)}],isError:false}};
    } catch(error) {return {jsonrpc:'2.0',id,result:{content:[{type:'text',text:error.message}],isError:true}};}
  }
  adjudicate(game) {
    const a=game.match.players.A.shots,b=game.match.players.B.shots;
    if(a.length!==b.length)return false;
    const hits=s=>s.filter(x=>x.hit).length,delta=hits(a)-hits(b);
    const seat=delta>0?'A':delta<0?'B':game.tieSeat;
    game.status='finished';game.winner=game[seat];
    Object.assign(game.match,{status:'finished',winner:seat,finishedAt:new Date().toISOString()});
    game.resultReason=delta?'Time limit: most hits after equal turns':'Time limit: equal hits; preassigned random tiebreak';
    this.save();return true;
  }
  publicState() {
    const s=this.state;
    return {id:s.id,revision:s.revision,demo:s.demo,model:s.model,status:s.status,round:s.round,startsAt:s.startsAt,notice:s.notice,winner:s.winner,byes:s.byes||[],matchSeconds:this.options.matchSeconds,teams:s.teams.map(({id,name,ready})=>({id,name,ready})),games:s.games.map(g=>({id:g.id,round:g.round,A:g.A,B:g.B,status:g.status,winner:g.winner,turn:g.match.turn,elapsedMs:g.elapsedMs,resultReason:g.resultReason,shots:g.match.events.filter(e=>e.type==='shot').map(({reason,...shot})=>shot),...(g.status==='finished'?{fleets:{A:g.match.players.A.fleet,B:g.match.players.B.fleet}}:{})}))};
  }
  adminState() {return {...this.publicState(),codes:this.state.teams.map(({id,code})=>({id,code})),usage:{requests:this.state.requests,totalTokens:this.state.totalTokens,maxRequests:this.options.maxRequests,maxTotalTokens:this.options.maxTotalTokens}};}
}
