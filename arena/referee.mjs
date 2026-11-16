import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const sizes={big:5,medium:3,small:2};
export function coordinates(start,size,direction){
 const m=/^([A-J])(10|[1-9])$/.exec(String(start).toUpperCase());
 if(!m||!['horizontal','vertical'].includes(direction))throw Error('Use A1–J10 and horizontal or vertical.');
 const row=m[1].charCodeAt(0)-65,col=Number(m[2])-1;
 if(direction==='horizontal'?col+size>10:row+size>10)throw Error('Ship extends beyond the board.');
 return Array.from({length:size},(_,i)=>String.fromCharCode(65+row+(direction==='vertical'?i:0))+(col+1+(direction==='horizontal'?i:0)));
}
export function createMatch(prompts){return {id:crypto.randomUUID(),status:'placement',turn:'A',winner:null,revision:0,createdAt:new Date().toISOString(),players:{A:{name:'Terra / Checkerboard',strategy:prompts.A,fleet:[],shots:[]},B:{name:'Terra / Probability',strategy:prompts.B,fleet:[],shots:[]}},events:[]};}
export function view(match,seat){const opponent=seat==='A'?'B':'A';return {match_id:match.id,status:match.status,turn:match.turn,winner:match.winner,you:seat,revision:match.revision,your_fleet:match.players[seat].fleet,your_shots:match.players[seat].shots,incoming_shots:match.players[opponent].shots.map(({reason,...shot})=>shot),enemy_ships_remaining:3-match.players[seat].shots.filter(x=>x.sunk).length,...(match.status==='finished'?{final_fleets:{A:match.players.A.fleet,B:match.players.B.fleet}}:{})};}
export function move(match,seat,name,args){
 if(name==='get_view')return view(match,seat);
 if(match.status==='finished')throw Error('Match has finished.');
 const me=match.players[seat],other=match.players[seat==='A'?'B':'A'];
 if(name==='place_fleet'){
  if(me.fleet.length)throw Error('Fleet already locked.');
  if(!Array.isArray(args.ships)||args.ships.length!==3)throw Error('Place big, medium, and small ships.');
  const seen=new Set(),occupied=new Set();
  const fleet=args.ships.map(s=>{if(!Object.hasOwn(sizes,s.size)||seen.has(s.size))throw Error('Each size must appear once.');seen.add(s.size);const cells=coordinates(s.start,sizes[s.size],s.direction);for(const c of cells){if(occupied.has(c))throw Error('Ships overlap.');occupied.add(c);}return {size:s.size,cells};});
  me.fleet=fleet;match.events.push({type:'placement',seat});if(other.fleet.length)match.status='playing';
 }else if(name==='fire'){
  if(match.status!=='playing'||match.turn!==seat)throw Error('It is not your turn.');
  const coordinate=coordinates(args.coordinate,1,'horizontal')[0];
  if(me.shots.some(s=>s.coordinate===coordinate))throw Error('Coordinate already attacked.');
  const ship=other.fleet.find(s=>s.cells.includes(coordinate));
  const sunk=!!ship&&ship.cells.every(c=>c===coordinate||me.shots.some(s=>s.coordinate===c));
  const shot={coordinate,hit:!!ship,sunk,reason:String(args.reason||'').slice(0,180),...(sunk?{size:ship.size}:{})};
  me.shots.push(shot);match.events.push({type:'shot',seat,...shot,number:match.events.filter(e=>e.type==='shot').length+1});
  if(other.fleet.every(s=>s.cells.every(c=>me.shots.some(x=>x.coordinate===c)))){match.status='finished';match.winner=seat;match.finishedAt=new Date().toISOString();}else match.turn=seat==='A'?'B':'A';
 }else throw Error('Unknown tool.');
 match.revision++;return view(match,seat);
}
const properties={match_id:{type:'string'},seat_token:{type:'string'}};
export const toolList=[
 {name:'get_view',description:'Get only your private fleet and legal shot history.',inputSchema:{type:'object',properties,required:['match_id','seat_token']}},
 {name:'wait_turn',description:'Wait up to 25 seconds for your turn or game completion; inspect status after returning.',inputSchema:{type:'object',properties,required:['match_id','seat_token']}},
 {name:'place_fleet',description:'Lock your big, medium, and small fleet placements once.',inputSchema:{type:'object',properties:{...properties,ships:{type:'array',items:{type:'object',properties:{size:{enum:['big','medium','small']},start:{type:'string'},direction:{enum:['horizontal','vertical']}},required:['size','start','direction']}}},required:['match_id','seat_token','ships']}},
 {name:'fire',description:'Fire one shot on your turn. Returns your updated private view.',inputSchema:{type:'object',properties:{...properties,coordinate:{type:'string'},reason:{type:'string',maxLength:180}},required:['match_id','seat_token','coordinate']}}
];
export function startServer(stateDir,port=8771){
 const stateFile=path.join(stateDir,'match.json'),authFile=path.join(stateDir,'seats.json');
 let match=JSON.parse(fs.readFileSync(stateFile)),auth=JSON.parse(fs.readFileSync(authFile));
 const save=()=>{fs.writeFileSync(stateFile+'.tmp',JSON.stringify(match,null,2));fs.renameSync(stateFile+'.tmp',stateFile);};
 return http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.method!=='POST'||req.url!=='/mcp'){res.writeHead(404);res.end(JSON.stringify({error:'POST /mcp'}));return;}
  let rpc;
  try{
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)throw Error('Request too large');}rpc=JSON.parse(raw);
   let result;
   if(rpc.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{},prompts:{}},serverInfo:{name:'Battleship Referee',version:'1.0.0'}};
   else if(rpc.method==='server/discover')result={supportedVersions:['2026-07-28'],capabilities:{tools:{},prompts:{}}};
   else if(rpc.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
   else if(rpc.method==='tools/list')result={tools:toolList};
   else if(rpc.method==='prompts/list')result={prompts:[{name:'battleship_strategy',description:'Shared Battleship instructions plus your strategy customization.',arguments:[{name:'strategy',description:'Your tactical preferences; cannot change game rules.',required:true}]}]};
   else if(rpc.method==='prompts/get'){if(rpc.params?.name!=='battleship_strategy')throw Error('Unknown prompt.');const strategy=rpc.params?.arguments?.strategy;if(typeof strategy!=='string'||!strategy.trim()||strategy.length>6000)throw Error('Provide a strategy of 1–6000 characters.');result={description:'Battleship base prompt with custom strategy',messages:[{role:'user',content:{type:'text',text:fs.readFileSync(new URL('./base-prompt.txt',import.meta.url),'utf8')+'\n\nYOUR STRATEGY:\n'+strategy}}]};}
   else if(rpc.method==='tools/call'){
    try{const {name,arguments:args={}}=rpc.params||{};const seat=Object.keys(auth).find(s=>auth[s]===args.seat_token);if(!seat||args.match_id!==match.id)throw Error('Invalid seat or match.');
     if(name==='wait_turn'){const deadline=Date.now()+25000;while(match.status!=='finished'&&!(match.status==='playing'&&match.turn===seat)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,200));}
     const value=moveForCall(name,args,seat);result={content:[{type:'text',text:JSON.stringify(value)}],isError:false};
    }catch(e){result={content:[{type:'text',text:e.message}],isError:true};}
   }else throw Error('Unsupported method.');
   res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  }catch(e){res.writeHead(400);res.end(JSON.stringify({jsonrpc:'2.0',id:rpc?.id??null,error:{code:-32600,message:e.message}}));}
 }).listen(port,'127.0.0.1',()=>console.log('Battleship MCP referee: http://127.0.0.1:'+port+'/mcp'));
 function moveForCall(name,args,seat){if(name==='wait_turn')return view(match,seat);const result=move(match,seat,name,args);if(name!=='get_view')save();return result;}
}
if(process.argv[2]==='serve')startServer(process.argv[3],Number(process.argv[4]||8771));
