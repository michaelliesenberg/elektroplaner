"use strict";
/* Website-Teil: Anmeldung (Supabase, E-Mail-Link), Häuser, Beteiligte, Wartungsbuch, Speichern.
   Ohne Zugangsdaten in config.js läuft alles im Demo-Modus nur in diesem Browser. */
const ROLE={owner:'Besitzer',family:'Familie',electrician:'Elektriker'};
const LOGTYPES=['Installation','Erweiterung / Änderung','Wartung','Prüfung (E-Check / DGUV V3)','Störung / Reparatur'];
const S={sb:null,mode:'demo',uid:null,email:'',houses:{},cur:null,tab:'plan',floor:0,dirty:false,log:[],members:[],invites:[],chan:null,confirmDelete:false};
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
    if(!Object.keys(S.houses).length) S.houses={demo:{name:'Musterhaus (Beispiel)',role:'owner',data:withExampleFloor(examplePlan())}};
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
const STEPS=[['plan','1','Grundriss & Räume'],['art','2','Konventionell oder smart'],['ergebnis','3','Ergebnis']];
const AWS={1:'Einfach',2:'Standard',3:'Komfort'};
function render(){
  const sel=$('#planSel'),ids=Object.keys(S.houses);
  sel.innerHTML=ids.map(id=>`<option value="${esc(id)}"${id===S.cur?' selected':''}>${esc(S.houses[id].name||'Ohne Namen')}</option>`).join('')||'<option>Noch kein Haus</option>';
  const p=plan(),m=$('#main');
  if(!p){m.innerHTML=`<div class="empty" style="margin-top:24px"><h2>Noch kein Haus</h2><p>Lege ein neues Haus an oder schau dir das Musterhaus an. Wenn dich jemand eingeladen hat, erscheint das Haus hier, sobald du dich mit der eingeladenen Adresse angemeldet hast.</p><div class="row" style="justify-content:center"><button class="btn primary" data-act="new">Neues Haus</button><button class="btn" data-act="example">Musterhaus ansehen</button></div></div>`;return}
  if(S.floor>=p.floors.length) S.floor=0;
  m.innerHTML=`
  <div class="housebar"><input type="text" id="pName" maxlength="80" aria-label="Name des Hauses" value="${esc(p.name)}">
    <span class="muted" style="font-size:13px">Deine Rolle: <span class="role">${esc(ROLE[myRole()]||'')}</span></span></div>
  ${p.example?'<p class="note">Das ist das Musterhaus. Sobald du etwas änderst, wird es gespeichert.</p>':''}
  <nav class="steps" role="tablist">${STEPS.map(([k,nr,l])=>`<button role="tab" data-tab="${k}" aria-selected="${S.tab===k}"><span class="nr">${nr}</span>${l}</button>`).join('')}
    <span class="more"><button role="tab" data-tab="wartung" aria-selected="${S.tab==='wartung'}">Wartungsbuch</button><button role="tab" data-tab="beteiligte" aria-selected="${S.tab==='beteiligte'}">Beteiligte</button></span></nav>
  <div id="tab"></div>`;
  const t=$('#tab');
  ({plan:stepPlan,art:stepArt,ergebnis:stepResult,wartung:tabLog,beteiligte:tabMembers})[S.tab](t,p);
}
function next(tab,label){return `<div class="nextbar"><button class="btn primary big" data-tab="${tab}">${label} →</button></div>`}
function roomCard(p,fi,ri){
  const r=p.floors[fi].rooms[ri],rv=rec(r,p.aw),geo=!!r.items;
  const extra=DEV.filter(d=>!d.core&&(n(r,d.k)||rv[d.k])),addable=DEV.filter(d=>!d.core&&!extra.includes(d));
  const sum=DEV.filter(d=>n(r,d.k)).map(d=>`<span class="chip"><b>${d.c}</b> ${n(r,d.k)}</span>`).join('')||'<span class="muted">keine Anschlüsse</span>';
  return `<article class="room${ED.sel===r.id?' sel':''}"><div class="roomhead"><input type="text" class="name" aria-label="Raumname" data-rname="${fi}:${ri}" value="${esc(r.name)}"><button class="btn small ghost" data-rmroom="${fi}:${ri}" aria-label="Raum löschen">✕</button></div>
   <div class="roommeta"><select aria-label="Raumtyp" data-rtype="${fi}:${ri}">${Object.entries(RT).map(([k,v])=>`<option value="${k}"${k===r.type?' selected':''}>${v.n}</option>`).join('')}</select><span class="muted" style="font-size:13px">${+r.area?String(r.area).replace('.',',')+' m²':''}</span></div>
   <details><summary>${DEV.reduce((a,d)=>a+n(r,d.k),0)} Anschlüsse · ändern</summary><div class="chips" style="margin:8px 0">${sum}</div>
   <div class="roommeta" style="margin-bottom:6px"><label>m² <input type="number" min="0" step="0.5" data-rarea="${fi}:${ri}" value="${+r.area||0}"></label>
   <label>Fenster <input type="number" min="0" data-rwin="${fi}:${ri}" value="${+r.windows||0}"></label></div><div class="devs">${DEV.filter(d=>d.core).concat(extra).map(d=>devRow(r,d,rv,fi,ri)).join('')}</div>
   <div class="roomfoot"><button class="btn small" data-recroom="${fi}:${ri}">Vorschlag neu setzen</button>
   ${addable.length?`<select aria-label="Anschluss hinzufügen" data-adddev="${fi}:${ri}"><option value="">+ Anschluss</option>${addable.map(d=>`<option value="${d.k}">${esc(d.l)}</option>`).join('')}</select>`:''}</div>
   ${geo?'<p class="muted" style="font-size:12.5px;margin:6px 0 0">Neue Anschlüsse erscheinen in der Raummitte, im Grundriss mit „Verschieben“ an die richtige Stelle ziehen.</p>':''}</details></article>`;
}
function stepPlan(t,p){
  const fi=S.floor,f=p.floors[fi];
  let h=`<div class="floorbar">${p.floors.length>1?`<div class="seg" role="group" aria-label="Etage">${p.floors.map((x,i)=>`<button data-floorsel="${i}" aria-pressed="${i===fi}">${esc(x.name)}</button>`).join('')}</div>`:''}
    <button class="btn small ghost" data-act="addfloor">+ Etage</button>${!f.rooms.length&&!f.plan&&p.floors.length>1?`<button class="btn small ghost" data-rmfloor="${fi}">Etage löschen</button>`:''}</div>`;
  const cards=f.rooms.map((r,ri)=>roomCard(p,fi,ri)).join('');
  if(f.plan){
    h+=`<div class="planlayout"><div>${editorHTML(p,fi)}</div><aside class="side">${pendingHTML(p,fi)}<div class="roomlist">${cards}</div></aside></div>`;
  }else{
    h+=`<label class="drop"><input type="file" id="planFile" accept="image/*,application/pdf" hidden>
        <b>Grundriss hochladen</b><span>Bild oder PDF${p.floors.length>1?` für ${esc(f.name)}`:''}. Danach nur noch den Maßstab antippen.</span><span class="btn primary">Datei wählen</span></label>
      <p class="muted" style="text-align:center;margin:14px 0;font-size:14px">Kein Grundriss? <button class="btn small ghost" data-addroom="${fi}">Räume von Hand anlegen</button></p>
      <div class="rooms">${cards}</div>${f.rooms.length?next('art','Weiter'):''}`;
  }
  t.innerHTML=h;
}
function stepArt(t,p){
  const konv=isKonv(p);
  let h=`<div class="row" style="margin-bottom:14px"><span class="lbl">Ausstattung</span><span class="seg" role="group">${[1,2,3].map(a=>`<button data-aw="${a}" aria-pressed="${p.aw===a}" title="Ausstattungswert ${a} (DIN 18015-2 / RAL-RG 678)">${AWS[a]}</button>`).join('')}</span></div>
  <div class="choice">
   <button class="opt${konv?' on':''}" data-mode="konv"><b>Konventionell</b><span>Normale Schalter und Steckdosen. Smart wird es mit Zwischensteckern oder kleinen Shelly-Modulen hinter dem Schalter, auch später.</span></button>
   <button class="opt${!konv?' on':''}" data-mode="smart"><b>Smart</b><span>Alles läuft über eine Steuerung im Verteiler. Licht, Rollläden und Heizung sind von Anfang an in der App.</span></button></div>`;
  if(konv){
    h+=`<h3 class="sub">Was soll smart werden?</h3><div class="choice three">${Object.entries(PRESETS).map(([k,v])=>`<button class="opt${p.preset===k?' on':''}" data-preset="${k}"><b>${v.l}</b><span>${v.d}</span></button>`).join('')}</div>`;
    const rows=[];p.floors.forEach((f,fi)=>f.rooms.forEach((r,ri)=>{const cells=RETRO.map(x=>{const mx=retroMax(r,x);return mx?`<td><span class="step"><button aria-label="weniger" data-rdec="${fi}:${ri}:${x.k}">−</button><span>${retro(r,x.k)}</span><button aria-label="mehr" data-rinc="${fi}:${ri}:${x.k}">+</button></span><span class="muted" style="font-size:12px"> von ${mx}</span></td>`:'<td class="muted">–</td>'});rows.push(`<tr><td><b>${esc(r.name)}</b><div class="muted" style="font-size:12px">${esc(f.name)}</div></td>${cells.join('')}</tr>`)}));
    h+=rows.length?`<div class="card" style="margin-top:14px"><h3 style="margin-bottom:6px">Pro Raum anpassen</h3><p class="muted" style="font-size:13px;margin-top:0">Zwischenstecker brauchen keinen Elektriker. Alles andere sitzt in der Schalterdose und baut die Elektrofachkraft ein.</p>
      <div class="tablewrap"><table><thead><tr><th>Raum</th>${RETRO.map(x=>`<th>${esc(x.l)}<div class="muted" style="font-weight:400;font-size:11.5px;text-transform:none;letter-spacing:0">${esc(x.art)}</div></th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div></div>`:'<p class="empty">Lege zuerst Räume an.</p>';
  }else{
    const SD={luxor:'Theben LUXORliving: günstiger Einstieg in die Busanlage, einfache Inbetriebnahme. Busleitung zu Tastern und Meldern.',knx:'KNX: offener Standard mit vielen Herstellern, am flexibelsten, braucht einen KNX-Elektriker.',shelly:'Shelly Pro im Verteiler: ohne Busleitung, normale Taster, Verbindung über Netzwerk. Günstig, gut für Sanierung.'};
    h+=`<h3 class="sub">Welches System?</h3><div class="choice three">${Object.entries(SYS).map(([k,v])=>`<button class="opt${p.system===k?' on':''}" data-sys="${k}"><b>${v}</b><span>${SD[k]}</span></button>`).join('')}</div>`;
  }
  h+=next('ergebnis','Weiter: Ergebnis mit Kabeln und Einkaufsliste');
  t.innerHTML=h;
}
function stepResult(t,p){
  const K=cableRuns(p),cs=circuits(p).list,G=shopping(p);
  const tot=Object.values(K.tot).reduce((a,b)=>a+b,0)*1.15;
  t.innerHTML=`<div class="stats">
    <div class="stat"><b class="mono">${allRooms(p).length}</b><span>Räume</span></div>
    <div class="stat"><b class="mono">${cs.length}</b><span>Stromkreise</span></div>
    <div class="stat"><b class="mono">${Math.round(tot)} m</b><span>Leitungen gesamt (+15 %)</span></div>
    <div class="stat"><b class="mono">${isKonv(p)?'Konv.':SYS[p.system]}</b><span>${isKonv(p)?'mit Smart-Nachrüstung':'Steuerung'}</span></div></div>
   <section class="res"><h2>Kabellängen</h2>
    <p class="muted" style="font-size:13.5px">${K.allMeasured?'Aus dem Grundriss gemessen: Weg entlang der Wände vom Verteiler zu jedem Anschluss, dazu die Höhen.':K.anyMeasured?'Räume mit Grundriss sind gemessen, die anderen grob geschätzt.':'Grob geschätzt. Mit Grundriss werden die Längen pro Anschluss gemessen.'} Richtwert für die Bestellung, die Elektrofachkraft legt Querschnitte und Wege fest.</p>
    <div class="tablewrap"><table><thead><tr><th>Leitung</th><th class="num">Länge</th><th class="num">mit 15 % Reserve</th></tr></thead><tbody>
     ${CABLES.filter(c=>K.tot[c.k]).map(c=>`<tr><td>${esc(c.l)}</td><td class="num">${Math.round(K.tot[c.k])} m</td><td class="num"><b>${Math.ceil(K.tot[c.k]*1.15)} m</b>${c.ring?` <span class="muted">(${Math.ceil(K.tot[c.k]*1.15/c.ring)}× ${c.ring} m)</span>`:''}</td></tr>`).join('')||'<tr><td colspan="3" class="muted">Noch keine Anschlüsse.</td></tr>'}</tbody></table></div>
    <details style="margin-top:8px"><summary>Pro Raum</summary><div class="tablewrap"><table><thead><tr><th>Raum</th>${CABLES.filter(c=>K.tot[c.k]).map(c=>`<th class="num">${esc(c.l.split(' (')[0])}</th>`).join('')}</tr></thead><tbody>
     ${K.rooms.map(r=>`<tr><td>${esc(r.room)} <span class="muted">· ${esc(r.floor)}${r.measured?'':' · geschätzt'}</span></td>${CABLES.filter(c=>K.tot[c.k]).map(c=>`<td class="num">${r.runs[c.k]?Math.round(r.runs[c.k])+' m':'–'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></section>
   <section class="res"><h2>Einkaufsliste</h2><div id="resList"></div></section>
   <section class="res"><h2>Stromkreise und Verteiler</h2><div id="resCirc"></div></section>
   <section class="res"><h2>In die App übernehmen</h2><div id="resExp"></div></section>`;
  tabList($('#resList'),p);tabCircuits($('#resCirc'),p);tabExport($('#resExp'),p);
}

function download(filename,text,mime){
  const url=URL.createObjectURL(new Blob([text],{type:mime}));
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(url);a.remove()},1000);
}

/* ---------- Ereignisse */
function resetRoom(p,f,r){r.dev=rec(r,p.aw);if(r.items&&f.plan){autoPlace(f,r);syncDev(r)}if(isKonv(p))presetRoom(p.preset,r)}
async function uploadPlan(file){
  const fi=S.floor;setSync('Grundriss wird geladen …');document.body.classList.add('busy');
  try{const pl=await loadPlanFile(file),p=plan(),f=p.floors[fi];f.plan=pl;f.rooms.forEach(r=>{delete r.rect;delete r.items});
    ED.tool='scale';ED.scalePts=[];ED.askScale=false;ED.zoom=1;changed();}
  catch(e){toast('Grundriss ließ sich nicht laden: '+errText(e));setSync('')}
  finally{document.body.classList.remove('busy')}
}
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
    case 'example':newHouse(withExampleFloor(examplePlan()));return;
    case 'askdel':S.confirmDelete=true;render();return;
    case 'nodel':S.confirmDelete=false;render();return;
    case 'delhouse':deleteHouse();return;
    case 'leave':{const {error}=await S.sb.from('members').delete().eq('house_id',S.cur).eq('user_id',S.uid);if(error)toast(errText(error));else{toast('Haus verlassen');loadHouses()}return}
  }
  if(!p) return;
  if(d.aw){p.aw=+d.aw;p.floors.forEach(f=>f.rooms.forEach(r=>resetRoom(p,f,r)));changed();toast('Vorschläge für alle Räume neu gesetzt');return}
  if(d.sys){p.system=d.sys;changed();return}
  if(d.inc||d.dec){const {f,r,k}=at(d.inc||d.dec);
    if(r.items&&f.plan){if(d.inc)addItem(f,r,k);else removeItem(r,k)}else{r.dev=r.dev||{};r.dev[k]=Math.max(0,n(r,k)+(d.inc?1:-1))}
    if(isKonv(p))presetRoom(p.preset,r);changed();return}
  if(d.recroom){const {f,r}=at(d.recroom+':x');resetRoom(p,f,r);changed();return}
  if(d.floorsel!=null){S.floor=+d.floorsel;ED.pending=null;ED.scalePts=[];ED.askScale=false;ED.zoom=1;render();return}
  if(d.mode){p.mode=d.mode;if(d.mode==='konv'&&!p.preset)applyPreset(p,'plug');changed();return}
  if(d.preset){applyPreset(p,d.preset);changed();return}
  if(d.rinc||d.rdec){const {r,k}=at(d.rinc||d.rdec);r.retro=r.retro||{};r.retro[k]=Math.max(0,retro(r,k)+(d.rinc?1:-1));changed();return}
  if(d.rmroom){const [fi,ri]=d.rmroom.split(':');p.floors[+fi].rooms.splice(+ri,1);changed();return}
  if(d.addroom){const r={id:uid(),name:'Neuer Raum',type:'wohnen',area:16,windows:1,dev:{}};r.dev=rec(r,p.aw);if(isKonv(p))presetRoom(p.preset,r);p.floors[+d.addroom].rooms.push(r);changed();return}
  if(d.rmfloor){p.floors.splice(+d.rmfloor,1);S.floor=0;changed();return}
  switch(d.act){
    case 'addfloor':p.floors.push({id:uid(),name:['EG','OG','DG','KG'][p.floors.length]||'Etage '+(p.floors.length+1),rooms:[]});S.floor=p.floors.length-1;changed();break;
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
  if(d.rtype){const {f,r}=at(d.rtype+':x');r.type=el.value;if(r.name==='Neuer Raum') r.name=RT[el.value].n;resetRoom(p,f,r);changed();return}
  if(d.rarea){at(d.rarea+':x').r.area=Math.max(0,+el.value||0);changed();return}
  if(d.rwin){const {f,r}=at(d.rwin+':x');r.windows=Math.max(0,parseInt(el.value)||0);resetRoom(p,f,r);changed();return}
  if(el.id==='planFile'&&el.files[0]){uploadPlan(el.files[0]);return}
  if(d.adddev){if(!el.value) return;const {f,r}=at(d.adddev+':x');if(r.items&&f.plan){if(!n(r,el.value))addItem(f,r,el.value)}else{r.dev=r.dev||{};r.dev[el.value]=Math.max(1,n(r,el.value))}changed();return}
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
