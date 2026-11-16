const $=id=>document.getElementById(id);
let state=null,selected='',source=null,adminToken='',connected=false,lastShotKey='';
let base=window.BATTLESHIP_CONFIG?.apiBase||'';
try{base=localStorage.getItem('battleship-api-base')||base;}catch{}
const node=(tag,text,className)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
function setMessage(id,message,error=false){$(id).textContent=message;$(id).classList.toggle('error',error);}
function connection(ok,text){connected=ok;$('connectionText').textContent=text;$('connectionDot').classList.toggle('online',ok);$('submitButton').disabled=!ok||state?.status!=='lobby';}
async function api(route,body,admin=false){const response=await fetch(base+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(admin?{Authorization:'Bearer '+adminToken}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed.');return data;}
function team(id){return state?.teams.find(t=>t.id===id)?.name||'Awaiting winner';}
function connect(){source?.close();state=null;connection(false,'Connecting');$('backendUrl').value=base||location.origin;
  source=new EventSource(base+'/api/events');
  source.onmessage=event=>{try{const next=JSON.parse(event.data);if(!Array.isArray(next.teams)||!Array.isArray(next.games))throw Error();state=next;connection(true,'Live connection');render();}catch{connection(false,'Invalid server response');}};
  source.onerror=()=>{connection(false,'Reconnecting');if(!state)setMessage('notice','No tournament server connected. Open Connection & organizer controls below and enter its address.',true);};
}
function render(){
  $('demoBanner').hidden=!state.demo;$('readyCount').textContent=state.teams.filter(t=>t.ready).length+' / 6';$('modelName').textContent=state.demo?'Scripted demo':state.model;
  $('eventStatus').textContent=({lobby:'Accepting strategies',countdown:'Launching',running:'Battles in progress',paused:'Paused',finished:'Champion crowned'})[state.status]||state.status;
  $('entryState').textContent=state.status==='lobby'?'OPEN':'LOCKED';$('roundBadge').textContent=state.round?['','OPENING ROUND','SEMIFINALS','FINAL'][state.round]:'AWAITING TEAMS';
  setMessage('notice',state.status==='finished'?'CHAMPION / '+team(state.winner):state.notice||'Six captains needed. Submit your strategy to join the fleet.');
  for(const input of $('submissionForm').querySelectorAll('input,textarea'))input.disabled=state.status!=='lobby';
  $('submitButton').disabled=!connected||state.status!=='lobby';
  $('roster').replaceChildren(...state.teams.map((t,i)=>{const row=node('div',undefined,'team-row'+(t.ready?' ready':''));row.append(node('span',String(i+1).padStart(2,'0'),'team-index'),node('strong',t.ready?t.name:'Awaiting captain'),node('span',t.ready?'READY ✓':'STANDBY','team-status'));return row;}));
  if(!state.games.some(g=>g.id===selected))selected=state.games.find(g=>g.status!=='finished')?.id||state.games[0]?.id||'';
  $('matchSelect').replaceChildren(...(state.games.length?state.games.map(g=>{const option=node('option',team(g.A)+' vs '+team(g.B));option.value=g.id;return option;}):[node('option','No matches yet')]));$('matchSelect').value=selected;
  renderBracket();renderMatch();countdown();
}
function renderBracket(){
  const rounds=[{title:'01 / OPENING ROUND',ids:['q1','q2']},{title:'02 / SEMIFINALS',ids:['s1','s2']},{title:'03 / CHAMPIONSHIP',ids:['final']}];
  $('bracket').replaceChildren(...rounds.map(round=>{const col=node('div',undefined,'bracket-column');col.append(node('div',round.title,'round-title'));
    for(const id of round.ids){const game=state.games.find(g=>g.id===id),card=node('button',undefined,'match-card'+(selected===id?' selected':''));card.type='button';card.disabled=!game;
      const label=node('div',undefined,'match-label');label.append(node('span',id.toUpperCase()),node('span',game?(game.status==='finished'?'COMPLETE':game.status==='playing'?'LIVE':'QUEUED'):'UP NEXT'));card.append(label);
      for(const seat of ['A','B']){let name=game?team(game[seat]):'Awaiting winner';if(!game&&id.startsWith('s')&&seat==='A'&&state.byes.length)name=team(state.byes[id==='s1'?0:1])+' · BYE';const contender=node('div',undefined,'contender'+(game?.winner===game?.[seat]&&game?' winner':''));contender.append(node('span',name),node('span',game&&game.winner===game[seat]?'✓':'—'));card.append(contender);}
      card.onclick=()=>{selected=id;render();};col.append(card);
    }
    if(round.ids[0]==='q1')col.append(node('p',state.byes.length?'Byes: '+state.byes.map(team).join(' & '):'Two random byes into the semifinals.','bye-note'));
    return col;
  }));
}
function renderMatch(){
  const g=state?.games.find(g=>g.id===selected);
  $('matchHeading').textContent=g?(g.id==='final'?'Championship':'Battle '+g.id.toUpperCase()):'Battle feed';
  $('matchStatus').textContent=g?(g.status==='finished'?team(g.winner)+' wins · '+g.resultReason:state.status==='paused'?'Event paused. Moves will resume together.':g.status==='pending'?'Preparing fleets…':team(g[g.turn])+' is choosing a move.'): 'The battle feed will open when the bracket is drawn.';
  const last=g?.shots.at(-1),key=g?.id+':'+g?.shots.length,newShot=key!==lastShotKey;lastShotKey=key;
  for(const seat of ['A','B']) {
    $('name'+seat).textContent=g?team(g[seat]):seat==='A'?'RED FLEET':'BLUE FLEET';
    const own=g?.shots.filter(s=>s.seat===seat)||[],incoming=g?.shots.filter(s=>s.seat!==seat)||[],fleet=g?.fleets?.[seat]?.flatMap(s=>s.cells)||[];
    $('stats'+seat).textContent=own.length+' shots / '+own.filter(s=>s.hit).length+' hits';
    const cells=[node('span','')];for(let c=1;c<=10;c++)cells.push(node('span',c));
    for(let r=0;r<10;r++){cells.push(node('span',String.fromCharCode(65+r)));for(let c=1;c<=10;c++){const coord=String.fromCharCode(65+r)+c,shot=incoming.find(s=>s.coordinate===coord);const latest=newShot&&last&&last.seat!==seat&&last.coordinate===coord;const cell=node('span',shot?(shot.hit?'×':'·'):'','water'+(fleet.includes(coord)?' ship':'')+(shot?(shot.hit?' hit':' miss'):'')+(latest?' latest':''));cell.title=coord+' · '+(shot?(shot.hit?'hit':'miss'):fleet.includes(coord)?'ship':'unknown');cell.setAttribute('aria-label',cell.title);cells.push(cell);}}
    $('board'+seat).replaceChildren(...cells);
  }
  $('shotLog').replaceChildren(...(g?.shots.slice(-8).reverse()||[]).map(s=>node('li','#'+s.number+' '+team(g[s.seat])+' → '+s.coordinate+' / '+(s.sunk?s.size+' SUNK':s.hit?'HIT':'MISS'),s.seat==='A'?'red':'blue')));
}
function countdown(){if(state?.status==='countdown')$('eventStatus').textContent='Starting in '+Math.max(0,Math.ceil((state.startsAt-Date.now())/1000))+'s';}
setInterval(countdown,250);
$('strategy').oninput=()=>{$('charCount').textContent=$('strategy').value.length+' / 6000';};
$('matchSelect').onchange=()=>{selected=$('matchSelect').value;renderBracket();renderMatch();};
$('submissionForm').onsubmit=async event=>{event.preventDefault();$('submitButton').disabled=true;try{const result=await api('submit',{name:$('teamName').value,code:$('teamCode').value.trim(),strategy:$('strategy').value});setMessage('formMessage',result.locked?'Strategy locked. The event is starting.':'Strategy saved. You can update it until all six teams are ready.');}catch(e){setMessage('formMessage',e.message,true);}finally{$('submitButton').disabled=!connected||state?.status!=='lobby';}};
$('connectionForm').onsubmit=event=>{event.preventDefault();try{const url=new URL($('backendUrl').value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Enter a backend origin only, such as https://example.com.');if(location.protocol==='https:'&&url.protocol!=='https:')throw Error('This website needs an HTTPS backend.');base=url.origin;try{localStorage.setItem('battleship-api-base',base);}catch{}adminToken='';$('adminControls').hidden=true;connect();}catch(e){setMessage('adminMessage',e.message,true);}};
function showAdmin(data){$('adminControls').hidden=false;$('fillDemo').hidden=!data.demo;$('usage').textContent=data.usage.requests+' / '+data.usage.maxRequests+' requests · '+data.usage.totalTokens.toLocaleString()+' tokens used';$('inviteCodes').replaceChildren(...data.codes.map(t=>node('div',t.id+' : '+t.code)));}
$('adminForm').onsubmit=async event=>{event.preventDefault();adminToken=$('adminToken').value;try{showAdmin(await api('admin',undefined,true));$('adminToken').value='';setMessage('adminMessage','Organizer controls unlocked for this page session.');}catch(e){adminToken='';$('adminControls').hidden=true;setMessage('adminMessage',e.message,true);}};
document.querySelectorAll('[data-action]').forEach(button=>button.onclick=async()=>{const action=button.dataset.action;let data={};if(action==='reset'){if(!confirm('Archive this event and issue six new team codes?'))return;data.confirm=state.id;}button.disabled=true;try{showAdmin(await api('admin/'+action,data,true));setMessage('adminMessage','Action completed.');}catch(e){setMessage('adminMessage',e.message,true);}finally{button.disabled=false;}});
for(const seat of ['A','B'])$('board'+seat).replaceChildren();
connect();
