"use strict";
/* Website-Teil: Anmeldung (Supabase, E-Mail-Link), Häuser, Beteiligte, Wartungsbuch, Speichern.
   Ohne Zugangsdaten in config.js läuft alles im Demo-Modus nur in diesem Browser. */
const ROLE={owner:'Besitzer',family:'Familie',electrician:'Elektriker'};
const LOGTYPES=['Installation','Erweiterung / Änderung','Wartung','Prüfung (E-Check / DGUV V3)','Störung / Reparatur'];
const S={sb:null,mode:'demo',uid:null,email:'',houses:{},cur:null,tab:'raeume',dirty:false,log:[],members:[],invites:[],chan:null,confirmDelete:false};
const LKEY='lh-elektroplaner-web-v1';

function plan(){const h=S.houses[S.cur];return h&&h.data}
function myRole(){const h=S.houses[S.cur];return h?h.role:null}
function setSync(t){$('#sync').textContent=t}
function newId(){return crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16)})}
function errText(e){return (e&&(e.message||e.error_description))||String(e)}

/* ---------- Start */
async function init(){
  const cfg=window.PLANER_CONFIG||{};
  if(cfg.supabaseUrl&&cfg.supabaseAnonKey&&window.supabase){
    S.mode='cloud';
    S.sb=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,detectSessionInUrl:true,flowType:'pkce'}});
    S.sb.auth.onAuthStateChange((ev,session)=>{
      if(ev==='SIGNED_OUT'){S.uid=null;showLogin();}
      else if(session&&session.user&&session.user.id!==S.uid){afterLogin(session)}
    });
    const {data}=await S.sb.auth.getSession();
    if(data.session) afterLogin(data.session); else showLogin();
  }else{
    S.mode='demo';
    try{S.houses=JSON.parse(localStorage.getItem(LKEY)||'{}')}catch(e){S.houses={}}
    if(!Object.keys(S.houses).length) S.houses={demo:{name:'Musterhaus (Beispiel)',role:'owner',data:examplePlan()}};
    S.cur=Object.keys(S.houses)[0];
    $('#planbar').hidden=false;
    $('#who').hidden=false;
    $('#who').innerHTML='<span class="role">Demo</span> Ohne Anmeldung: Pläne bleiben nur in diesem Browser.';
    setSync('Demo-Modus');
    render();
  }
}

function showLogin(sent){
  $('#planbar').hidden=true; $('#who').hidden=true;
  $('#main').innerHTML=`<section class="login">
    <h2>Anmelden</h2>
    <p class="muted">Für Familie und Elektriker: Du bekommst einen Anmelde-Link per E-Mail, ganz ohne Passwort. Wer eingeladen wurde, meldet sich mit genau der E-Mail-Adresse an, an die die Einladung ging.</p>
    ${sent?`<p class="note">Link gesendet an <b>${esc(sent)}</b>. Bitte im Postfach öffnen, gern auch auf diesem Gerät.</p>`:''}
    <form id="loginForm"><label class="lbl" for="loginMail">E-Mail-Adresse</label>
      <input type="email" id="loginMail" required autocomplete="email" placeholder="name@beispiel.de">
      <button class="btn primary" type="submit">Anmelde-Link senden</button></form>
  </section>`;
}

async function afterLogin(session){
  S.uid=session.user.id; S.email=session.user.email||'';
  $('#planbar').hidden=false; $('#who').hidden=false;
  $('#who').innerHTML=`Angemeldet als <b>${esc(S.email)}</b> <button class="btn small ghost" data-act="logout">Abmelden</button>`;
  try{const {data}=await S.sb.rpc('accept_invites'); if(data>0) toast(data===1?'Einladung angenommen':`${data} Einladungen angenommen`)}catch(e){}
  await loadHouses();
}

/* ---------- Häuser */
async function loadHouses(keep){
  if(S.mode!=='cloud') return;
  const {data,error}=await S.sb.from('members').select('role, houses(id,name,data,updated_at)').eq('user_id',S.uid);
  if(error){setSync('Laden fehlgeschlagen: '+errText(error));return}
  const next={};
  (data||[]).forEach(m=>{if(m.houses){const d=m.houses.data&&m.houses.data.floors?m.houses.data:blankPlan();d.name=m.houses.name;next[m.houses.id]={name:m.houses.name,role:m.role,updated_at:m.houses.updated_at,data:d}}});
  S.houses=next;
  if(!keep||!S.houses[S.cur]) S.cur=Object.keys(next).sort((a,b)=>String(next[b].updated_at).localeCompare(String(next[a].updated_at)))[0]||null;
  setSync('Gespeichert');
  subscribe(); render();
  if(S.tab==='wartung') loadLog(); if(S.tab==='beteiligte') loadMembers();
}

function subscribe(){
  if(S.mode!=='cloud') return;
  if(S.chan){S.sb.removeChannel(S.chan);S.chan=null}
  if(!S.cur) return;
  const id=S.cur;
  S.chan=S.sb.channel('haus-'+id)
    .on('postgres_changes',{event:'*',schema:'public',table:'houses',filter:'id=eq.'+id},pl=>{
      if(pl.eventType==='DELETE'){toast('Dieses Haus wurde gelöscht');loadHouses();return}
      if(S.dirty||!pl.new||pl.new.updated_by===S.uid||id!==S.cur) return;
      const d=pl.new.data&&pl.new.data.floors?pl.new.data:plan(); d.name=pl.new.name;
      Object.assign(S.houses[id],{name:pl.new.name,data:d,updated_at:pl.new.updated_at});
      setSync('Von jemand anderem aktualisiert'); render();
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'maintenance_log',filter:'house_id=eq.'+id},()=>{if(S.tab==='wartung') loadLog()})
    .subscribe();
}

let saveT=null;
function changed(){
  const p=plan(); if(!p) return; delete p.example; S.dirty=true;
  S.houses[S.cur].name=p.name;
  render(); setSync('Speichert …');
  clearTimeout(saveT); saveT=setTimeout(persist,700);
}
async function persist(){
  const p=plan(); if(!p) return;
  if(S.mode==='cloud'){
    const {error}=await S.sb.from('houses').update({name:p.name.slice(0,80),data:p}).eq('id',S.cur);
    setSync(error?'Nicht gespeichert: '+errText(error):'Gespeichert · für alle Beteiligten');
  }else{try{localStorage.setItem(LKEY,JSON.stringify(S.houses))}catch(e){} setSync('Gespeichert in diesem Browser')}
  S.dirty=false;
}
async function newHouse(p){
  if(S.mode==='cloud'){
    const id=newId();
    delete p.example;
    const {error}=await S.sb.from('houses').insert({id,name:p.name.slice(0,80),data:p});
    if(error){toast('Anlegen fehlgeschlagen: '+errText(error));return}
    S.cur=id; await loadHouses(true);
  }else{const id=newId();S.houses[id]={name:p.name,role:'owner',data:p};S.cur=id;try{localStorage.setItem(LKEY,JSON.stringify(S.houses))}catch(e){};render()}
}
async function deleteHouse(){
  if(S.mode==='cloud'){const {error}=await S.sb.from('houses').delete().eq('id',S.cur);if(error){toast(errText(error));return}await loadHouses()}
  else{delete S.houses[S.cur];S.cur=Object.keys(S.houses)[0]||null;try{localStorage.setItem(LKEY,JSON.stringify(S.houses))}catch(e){};render()}
  S.confirmDelete=false; toast('Haus gelöscht');
}

/* ---------- Wartungsbuch */
async function loadLog(){
  if(S.mode!=='cloud'){S.log=(plan()&&plan().log)||[];render();return}
  if(!S.cur) return;
  const {data,error}=await S.sb.from('maintenance_log').select('*').eq('house_id',S.cur).order('date',{ascending:false}).order('created_at',{ascending:false});
  if(!error){S.log=data||[];if(S.tab==='wartung') render()}
}
function tabLog(t,p){
  const today=new Date().toISOString().slice(0,10);
  const roomsOpts=['Ganzes Haus','Verteiler'].concat(allRooms(p).map(r=>`${r.floor} · ${r.name}`));
  const entries=S.log;
  const due=entries.filter(e=>e.next_date).map(e=>({...e,days:Math.round((new Date(e.next_date)-new Date(today))/864e5)})).sort((a,b)=>a.days-b.days);
  t.innerHTML=`<div class="grid2">
   <div class="card"><h3 style="margin-bottom:10px">Eintrag hinzufügen</h3>
    <form id="logForm" class="field" style="gap:10px">
     <div class="row"><div class="field"><label for="lgDate">Datum</label><input type="date" id="lgDate" value="${today}" required></div>
      <div class="field"><label for="lgType">Art</label><select id="lgType">${LOGTYPES.map(x=>`<option>${x}</option>`).join('')}</select></div></div>
     <div class="field"><label for="lgWhere">Bereich</label><select id="lgWhere">${roomsOpts.map(x=>`<option>${esc(x)}</option>`).join('')}</select></div>
     <div class="field"><label for="lgText">Was wurde gemacht?</label><textarea id="lgText" rows="3" required maxlength="4000" placeholder="z. B. FI/LS F7 getauscht, Rollladen Wohnzimmer Endlagen neu eingestellt"></textarea></div>
     <div class="field"><label for="lgNext">Nächster Termin (optional)</label><input type="date" id="lgNext"></div>
     <div><button class="btn primary" type="submit">Eintragen</button></div>
    </form>
    <p class="muted" style="font-size:13px;margin-bottom:0">Eingetragen als ${esc(ROLE[myRole()]||'')}${S.email?' ('+esc(S.email)+')':''}. Alle Beteiligten dieses Hauses sehen das Wartungsbuch.</p></div>
   <div class="card"><h3 style="margin-bottom:10px">Fällige Termine</h3>${due.length?due.map(e=>`<div class="row" style="margin-bottom:6px"><span class="pill ${e.days<0?'over':e.days<=60?'due':''}">${esc(e.next_date)}</span><span>${esc(e.type)} · ${esc(e.area)}</span></div>`).join(''):'<p class="muted">Keine Termine eingetragen. Üblich: E-Check alle 4 Jahre, FI-Prüftaste halbjährlich.</p>'}</div>
  </div>
  <div class="card" style="margin-top:16px"><h3 style="margin-bottom:10px">Verlauf</h3><div class="log">${entries.length?entries.map(e=>`<div class="logitem"><div class="mono" style="font-size:13px">${esc(e.date)}</div><div>
    <div><span class="pill">${esc(ROLE[e.role]||e.role||'')}</span><b>${esc(e.type)}</b> · ${esc(e.area)}</div><div style="white-space:pre-wrap">${esc(e.text)}</div>
    <div class="muted" style="font-size:12.5px">${esc(e.author_email||'')}${e.next_date?' · nächster Termin '+esc(e.next_date):''}
    ${(S.mode!=='cloud'||e.author===S.uid||myRole()==='owner')?` · <button class="btn small ghost" data-dellog="${esc(e.id)}">Löschen</button>`:''}</div></div></div>`).join(''):'<p class="muted">Noch keine Einträge. Hier dokumentiert der Elektriker, was er installiert, geprüft oder repariert hat.</p>'}</div></div>`;
}
async function addLog(entry){
  if(S.mode==='cloud'){
    const {error}=await S.sb.from('maintenance_log').insert({house_id:S.cur,author_email:S.email,role:myRole(),...entry});
    if(error){toast('Nicht gespeichert: '+errText(error));return}
    toast('Eingetragen'); loadLog();
  }else{const p=plan();p.log=p.log||[];p.log.unshift({id:newId(),role:'owner',author_email:'',...entry});S.log=p.log;changed();toast('Eingetragen')}
}
async function delLog(id){
  if(S.mode==='cloud'){const {error}=await S.sb.from('maintenance_log').delete().eq('id',id);if(error) toast(errText(error));loadLog()}
  else{const p=plan();p.log=(p.log||[]).filter(e=>e.id!==id);S.log=p.log;changed()}
}

/* ---------- Beteiligte */
async function loadMembers(){
  if(S.mode!=='cloud'||!S.cur){render();return}
  const [m,i]=await Promise.all([
    S.sb.from('members').select('user_id,role,email,added_at').eq('house_id',S.cur).order('added_at'),
    myRole()==='owner'?S.sb.from('invites').select('id,email,role,created_at').eq('house_id',S.cur).order('created_at'):Promise.resolve({data:[]})]);
  S.members=m.data||[]; S.invites=i.data||[];
  if(S.tab==='beteiligte') render();
}
function tabMembers(t,p){
  if(S.mode!=='cloud'){t.innerHTML='<div class="empty">Einladen geht erst, wenn die Website mit der Datenbank verbunden ist (siehe README).</div>';return}
  const owner=myRole()==='owner';
  const roleSel=(id,cur)=>`<select data-rolechg="${esc(id)}" aria-label="Rolle">${['family','electrician'].map(r=>`<option value="${r}"${r===cur?' selected':''}>${ROLE[r]}</option>`).join('')}</select>`;
  t.innerHTML=`<div class="grid2">
   <div class="card"><h3 style="margin-bottom:8px">Wer hat Zugang zu „${esc(p.name)}“?</h3><ul class="members">
    ${S.members.map(m=>`<li><span style="flex:1;min-width:12em">${esc(m.email||'Unbekannt')}${m.user_id===S.uid?' (du)':''}</span>
      ${owner&&m.role!=='owner'?roleSel(m.user_id,m.role)+` <button class="btn small ghost danger" data-rmmember="${esc(m.user_id)}">Entfernen</button>`:`<span class="role">${ROLE[m.role]}</span>`}
      ${!owner&&m.user_id===S.uid?`<button class="btn small ghost" data-act="leave">Haus verlassen</button>`:''}</li>`).join('')}
    ${S.invites.map(i=>`<li><span style="flex:1;min-width:12em">${esc(i.email)} <span class="muted">· eingeladen, noch nicht angemeldet</span></span><span class="role">${ROLE[i.role]}</span><button class="btn small ghost" data-rminvite="${esc(i.id)}">Zurückziehen</button></li>`).join('')}
   </ul>
   <p class="muted" style="font-size:13px">Besitzer: einladen, Rollen ändern, Haus löschen. Familie und Elektriker: planen und ins Wartungsbuch schreiben.</p></div>
   ${owner?`<div class="card"><h3 style="margin-bottom:8px">Jemanden einladen</h3>
    <form id="inviteForm" class="field" style="gap:10px">
     <div class="field"><label for="invMail">E-Mail-Adresse</label><input type="email" id="invMail" required placeholder="elektriker@firma.de"></div>
     <div class="field"><label for="invRole">Rolle</label><select id="invRole"><option value="electrician">Elektriker</option><option value="family">Familie</option></select></div>
     <label class="row" style="gap:6px;font-size:14px"><input type="checkbox" id="invSend" checked> Anmelde-Link gleich per E-Mail schicken</label>
     <div><button class="btn primary" type="submit">Einladen</button></div>
    </form>
    <p class="muted" style="font-size:13px">Die Person meldet sich mit genau dieser Adresse an und sieht danach nur dieses Haus.</p></div>
   <div class="card"><h3 style="margin-bottom:8px">Haus löschen</h3>
    ${S.confirmDelete?`<p>Wirklich „${esc(p.name)}“ mit Plan und Wartungsbuch für alle löschen?</p><div class="row"><button class="btn danger" data-act="delhouse">Endgültig löschen</button><button class="btn ghost" data-act="nodel">Abbrechen</button></div>`
      :`<p class="muted">Löscht Plan, Wartungsbuch und alle Zugänge zu diesem Haus.</p><button class="btn ghost danger" data-act="askdel">Haus löschen …</button>`}</div>`:''}
  </div>`;
}
async function invite(email,role,send){
  const {error}=await S.sb.from('invites').insert({house_id:S.cur,email:email.trim().toLowerCase(),role});
  if(error){toast(/duplicate|unique/i.test(errText(error))?'Diese Adresse ist schon eingeladen':'Einladen fehlgeschlagen: '+errText(error));return}
  if(send){
    const {error:e2}=await S.sb.auth.signInWithOtp({email:email.trim(),options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:true}});
    toast(e2?'Eingeladen, aber die E-Mail ging nicht raus: '+errText(e2):'Eingeladen, Anmelde-Link verschickt');
  }else toast('Eingeladen');
  loadMembers();
}

/* ---------- Darstellung */
function render(){
  const sel=$('#planSel'),ids=Object.keys(S.houses);
  sel.innerHTML=ids.map(id=>`<option value="${esc(id)}"${id===S.cur?' selected':''}>${esc(S.houses[id].name||'Ohne Namen')}</option>`).join('')||'<option>Noch kein Haus</option>';
  const p=plan(),m=$('#main');
  if(!p){m.innerHTML=`<div class="empty" style="margin-top:24px"><h2>Noch kein Haus</h2><p>Lege ein neues Haus an oder lade das Musterhaus als Vorlage. Wenn dich jemand eingeladen hat, erscheint das Haus hier, sobald du dich mit der eingeladenen Adresse angemeldet hast.</p><div class="row" style="justify-content:center"><button class="btn primary" data-act="new">Neues Haus</button><button class="btn" data-act="example">Beispiel laden</button></div></div>`;return}
  const tabs=[['raeume','Räume'],['kreise','Stromkreise & Verteiler'],['liste','Einkaufsliste'],['export','Export in die App'],['wartung','Wartungsbuch'],['beteiligte','Beteiligte']];
  m.innerHTML=`
  <section class="settings">
    <div class="field"><label for="pName">Haus / Projekt</label><input type="text" id="pName" maxlength="80" value="${esc(p.name)}"></div>
    <div class="field"><label for="pAdr">Adresse / Notiz</label><input type="text" id="pAdr" value="${esc(p.adresse||'')}"></div>
    <div class="field"><span class="lbl">Ausstattungswert</span><div class="seg" role="group">${[1,2,3].map(a=>`<button data-aw="${a}" aria-pressed="${p.aw===a}">${AWN[a]}</button>`).join('')}</div></div>
    <div class="field"><span class="lbl">Steuerung</span><div class="seg" role="group">${Object.entries(SYS).map(([k,v])=>`<button data-sys="${k}" aria-pressed="${p.system===k}">${v}</button>`).join('')}</div></div>
  </section>
  <div class="row" style="justify-content:space-between"><span class="muted" style="font-size:13px">Deine Rolle: <span class="role">${esc(ROLE[myRole()]||'')}</span></span></div>
  ${p.example?'<p class="note">Das ist ein Beispielplan. Sobald du etwas änderst, wird er gespeichert.</p>':''}
  <nav class="tabs" role="tablist">${tabs.map(([k,v])=>`<button role="tab" data-tab="${k}" aria-selected="${S.tab===k}">${v}</button>`).join('')}</nav>
  <div id="tab"></div>`;
  const t=$('#tab');
  ({raeume:tabRooms,kreise:tabCircuits,liste:tabList,export:tabExport,wartung:tabLog,beteiligte:tabMembers})[S.tab](t,p);
}

function download(filename,text,mime){
  const url=URL.createObjectURL(new Blob([text],{type:mime}));
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(url);a.remove()},1000);
}

/* ---------- Ereignisse */
function at(s){const [fi,ri,k]=s.split(':');return {f:plan().floors[+fi],r:plan().floors[+fi].rooms[+ri],k}}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button'); if(!b) return;
  const p=plan(), d=b.dataset;
  if(d.tab){S.tab=d.tab;S.confirmDelete=false;render();if(d.tab==='wartung') loadLog();if(d.tab==='beteiligte') loadMembers();return}
  if(d.dellog){delLog(d.dellog);return}
  if(d.rmmember){const {error}=await S.sb.from('members').delete().eq('house_id',S.cur).eq('user_id',d.rmmember);toast(error?errText(error):'Entfernt');loadMembers();return}
  if(d.rminvite){await S.sb.from('invites').delete().eq('id',d.rminvite);loadMembers();return}
  switch(d.act){
    case 'logout':await S.sb.auth.signOut();return;
    case 'new':newHouse(blankPlan());return;
    case 'example':newHouse(examplePlan());return;
    case 'askdel':S.confirmDelete=true;render();return;
    case 'nodel':S.confirmDelete=false;render();return;
    case 'delhouse':deleteHouse();return;
    case 'leave':{const {error}=await S.sb.from('members').delete().eq('house_id',S.cur).eq('user_id',S.uid);if(error)toast(errText(error));else{toast('Haus verlassen');loadHouses()}return}
  }
  if(!p) return;
  if(d.aw){p.aw=+d.aw;changed();return}
  if(d.sys){p.system=d.sys;changed();return}
  if(d.inc||d.dec){const {r,k}=at(d.inc||d.dec);r.dev=r.dev||{};r.dev[k]=Math.max(0,n(r,k)+(d.inc?1:-1));changed();return}
  if(d.recroom){const {r}=at(d.recroom+':x');r.dev=rec(r,p.aw);changed();return}
  if(d.rmroom){const [fi,ri]=d.rmroom.split(':');p.floors[+fi].rooms.splice(+ri,1);changed();return}
  if(d.addroom){const r={id:uid(),name:'Neuer Raum',type:'wohnen',area:16,windows:1,dev:{}};r.dev=rec(r,p.aw);p.floors[+d.addroom].rooms.push(r);changed();return}
  if(d.rmfloor){p.floors.splice(+d.rmfloor,1);changed();return}
  switch(d.act){
    case 'addfloor':p.floors.push({id:uid(),name:'Etage '+(p.floors.length+1),rooms:[]});changed();break;
    case 'allrec':p.floors.flatMap(f=>f.rooms).forEach(r=>r.dev=rec(r,p.aw));changed();toast('Alle Räume auf Richtwerte gesetzt');break;
    case 'copylist':copy(listText(p,shopping(p)));break;
    case 'csv':download(`Einkaufsliste-${slug(p.name)}.csv`,'﻿'+listCSV(shopping(p)),'text/csv;charset=utf-8');break;
    case 'copyjson':copy(JSON.stringify(hubExport(p),null,2));break;
    case 'savejson':download(`${slug(p.name)}.liesenberg-plan.json`,JSON.stringify(hubExport(p),null,2),'application/json');break;
  }
});
document.addEventListener('change',e=>{
  const el=e.target,d=el.dataset;
  if(el.id==='planSel'){S.cur=el.value;S.confirmDelete=false;subscribe();render();if(S.tab==='wartung') loadLog();if(S.tab==='beteiligte') loadMembers();return}
  if(d.rolechg){S.sb.from('members').update({role:el.value}).eq('house_id',S.cur).eq('user_id',d.rolechg).then(({error})=>{toast(error?errText(error):'Rolle geändert');loadMembers()});return}
  const p=plan(); if(!p) return;
  if(el.id==='pName'){p.name=el.value.trim().slice(0,80)||'Ohne Namen';changed();return}
  if(el.id==='pAdr'){p.adresse=el.value;changed();return}
  if(d.floor!=null){p.floors[+d.floor].name=el.value.trim()||'Etage';changed();return}
  if(d.rname){at(d.rname+':x').r.name=el.value.trim()||'Raum';changed();return}
  if(d.rtype){const {r}=at(d.rtype+':x');r.type=el.value;if(r.name==='Neuer Raum') r.name=RT[el.value].n;r.dev=rec(r,p.aw);changed();return}
  if(d.rarea){at(d.rarea+':x').r.area=Math.max(0,+el.value||0);changed();return}
  if(d.rwin){const {r}=at(d.rwin+':x');r.windows=Math.max(0,parseInt(el.value)||0);changed();return}
  if(d.adddev){if(!el.value) return;const {r}=at(d.adddev+':x');r.dev=r.dev||{};r.dev[el.value]=Math.max(1,n(r,el.value));changed();return}
});
document.addEventListener('submit',async e=>{
  e.preventDefault();
  const id=e.target.id;
  if(id==='loginForm'){
    const email=$('#loginMail').value.trim(); const btn=e.target.querySelector('button'); btn.disabled=true;
    const {error}=await S.sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:true}});
    btn.disabled=false;
    if(error){toast(/rate/i.test(errText(error))?'Zu viele Versuche, bitte in ein paar Minuten noch einmal':'Senden fehlgeschlagen: '+errText(error));return}
    showLogin(email);
  }
  if(id==='logForm'){
    const text=$('#lgText').value.trim(); if(!text) return;
    addLog({date:$('#lgDate').value,type:$('#lgType').value,area:$('#lgWhere').value,text,next_date:$('#lgNext').value||null});
  }
  if(id==='inviteForm') invite($('#invMail').value,$('#invRole').value,$('#invSend').checked);
});
$('#newPlan').onclick=()=>newHouse(blankPlan());
$('#examplePlan').onclick=()=>newHouse(examplePlan());
init();
