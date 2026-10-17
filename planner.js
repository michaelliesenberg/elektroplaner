"use strict";
/* Planungslogik des Liesenberg Elektroplaners – gleich wie in der Claude-Version */
/* ---------- Katalog ---------- */
const DEV=[
 {k:'steckdose',l:'Steckdosen',c:'SD',core:1},
 {k:'steckdose_schalt',l:'Schaltbare Steckdosen',c:'SS',core:1,kind:'light',base:'Steckdose',ch:'switch'},
 {k:'licht',l:'Leuchten (schalten)',c:'L',core:1,kind:'light',ch:'switch'},
 {k:'dimm',l:'Leuchten (dimmen)',c:'LD',core:1,kind:'dimmer',ch:'dim'},
 {k:'taster',l:'Taster-Stellen',c:'T',core:1},
 {k:'praesenz',l:'Präsenzmelder',c:'PM',core:1,kind:'other',base:'Präsenz'},
 {k:'rollladen',l:'Rollläden / Raffstore',c:'RL',core:1,kind:'blind',ch:'blind'},
 {k:'heizung',l:'Heizkreis (Raumregelung)',c:'HZ',core:1,kind:'heating',ch:'heat'},
 {k:'netzwerk',l:'Netzwerkdosen',c:'LAN',core:1},
 {k:'tv',l:'TV-/SAT-Dosen',c:'TV',core:1},
 {k:'herd',l:'Herd / Kochfeld 400 V',c:'H'},
 {k:'backofen',l:'Backofen',c:'BO'},
 {k:'gsp',l:'Geschirrspüler',c:'GS'},
 {k:'wm',l:'Waschmaschine',c:'WM'},
 {k:'trockner',l:'Trockner',c:'TR'},
 {k:'wallbox',l:'Wallbox 11 kW',c:'WB'},
 {k:'tor',l:'Tor / Garagentor',c:'TO',kind:'gate',ch:'gate'}
];
const DEVK=Object.fromEntries(DEV.map(d=>[d.k,d]));
// Richtwerte je Ausstattungswert 1/2/3 (angelehnt an DIN 18015-2 / RAL-RG 678)
const RT={
 wohnen:{n:'Wohnzimmer',sd:[4,7,10],li:[2,2,3],net:[1,2,2],tv:[1,1,2],big:20},
 essen:{n:'Esszimmer',sd:[3,4,6],li:[1,2,2],net:[0,1,1],tv:[0,0,1],big:16},
 kueche:{n:'Küche',sd:[5,7,9],li:[2,2,3],net:[0,1,1],tv:[0,0,1],big:12,ded:{herd:1,gsp:1,backofen:[0,1,1]}},
 schlafen:{n:'Schlafzimmer',sd:[4,6,8],li:[1,2,2],net:[1,1,2],tv:[1,1,1],big:16},
 kind:{n:'Kinderzimmer',sd:[4,6,8],li:[1,2,2],net:[1,1,2],tv:[1,1,1],big:14},
 arbeit:{n:'Arbeitszimmer',sd:[5,8,10],li:[1,2,2],net:[1,2,3],tv:[0,1,1],big:14},
 bad:{n:'Bad',sd:[2,3,4],li:[2,2,3],praes:[0,0,1]},
 wc:{n:'WC',sd:[1,1,2],li:[1,1,1],praes:[0,1,1]},
 flur:{n:'Flur / Diele',sd:[1,2,3],li:[1,2,3],praes:[0,1,1],heat:0},
 hwr:{n:'Hauswirtschaftsraum',sd:[3,4,5],li:[1,1,2],net:[0,0,1],ded:{wm:1,trockner:1}},
 keller:{n:'Keller / Abstellraum',sd:[1,2,3],li:[1,1,2],heat:0},
 garage:{n:'Garage / Carport',sd:[1,2,2],li:[1,1,2],heat:0,ded:{wallbox:[0,1,1],tor:[0,1,1]}},
 aussen:{n:'Außen / Terrasse',sd:[1,2,3],li:[1,2,3],heat:0,out:1},
 sonst:{n:'Sonstiger Raum',sd:[2,3,4],li:[1,1,2]}
};
const DIMMROOMS=new Set(['wohnen','essen','schlafen','kind','arbeit']);
const SYS={luxor:'LUXORliving',knx:'KNX',shelly:'Shelly'};
const AWN={1:'1 · Mindest',2:'2 · Standard',3:'3 · Komfort'};

/* ---------- Hilfen ---------- */
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)).replace(/-/g,'').slice(0,12);
const n=(r,k)=>Math.max(0,+((r.dev||{})[k]||0));
const isOut=r=>!!(RT[r.type]||{}).out;
const slug=s=>String(s).toLowerCase().replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'x';
function toast(t){const e=$('#toast');e.textContent=t;e.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>e.hidden=true,2400)}
async function copy(text){try{await navigator.clipboard.writeText(text);toast('Kopiert')}catch(e){const ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();toast('Text markiert, bitte mit Strg/Cmd+C kopieren');setTimeout(()=>ta.remove(),8000)}}
const allRooms=p=>p.floors.flatMap(f=>f.rooms.map(r=>({...r,floor:f.name})));
const total=(p,k,pred)=>allRooms(p).filter(pred||(()=>true)).reduce((s,r)=>s+n(r,k),0);

/* ---------- Empfehlung ---------- */
function rec(r,aw){
  const t=RT[r.type]||RT.sonst,i=aw-1,v=a=>Array.isArray(a)?a[i]:(a||0),o={};
  let sd=v(t.sd); if(t.big&&r.area>t.big) sd+=Math.ceil((r.area-t.big)/8)*(aw>=2?2:1);
  let li=v(t.li); if(r.area>25) li+=1;
  const dimm=DIMMROOMS.has(r.type)?(aw===3?li:aw===2?1:0):0;
  o.steckdose=sd; o.licht=li-dimm; o.dimm=dimm;
  o.taster=t.out?1:1+((r.type==='flur'||r.area>20)?1:0)+(aw===3&&!['wc','keller'].includes(r.type)?1:0);
  o.praesenz=v(t.praes); o.netzwerk=v(t.net); o.tv=v(t.tv);
  o.rollladen=t.out?0:(+r.windows||0);
  o.heizung=t.heat===0||t.out?0:1;
  for(const [k,a] of Object.entries(t.ded||{})) o[k]=v(a);
  return o;
}

/* ---------- Stromkreise ---------- */
function circuits(p){
  const out=[];
  const B10='FI/LS B10 · 30 mA Typ A', B16='FI/LS B16 · 30 mA Typ A';
  const add=o=>out.push({poles:1,te:1,load:1,...o});
  p.floors.forEach(f=>{
    const inn=f.rooms.filter(r=>!isOut(r));
    const lights=inn.reduce((s,r)=>s+n(r,'licht')+n(r,'dimm'),0);
    const lc=Math.ceil(lights/12);
    for(let i=0;i<lc;i++) add({name:`Beleuchtung ${f.name}${lc>1?' '+(i+1):''}`,where:f.name,prot:B10,cable:'NYM-J 3×1,5',load:.4,type:'light'});
    const rl=inn.reduce((s,r)=>s+n(r,'rollladen'),0);
    if(rl) add({name:`Rollläden ${f.name}`,where:f.name,prot:B10,cable:'NYM-J 3×1,5 / 5×1,5',load:.3,type:'blind'});
    let pool=[],pn=0;
    const flush=()=>{if(pool.length){add({name:`Steckdosen ${pool.join(', ')}`,where:f.name,prot:B16,cable:'NYM-J 3×2,5',load:1.4,type:'socket'});pool=[];pn=0}};
    inn.forEach(r=>{
      const s=n(r,'steckdose')+n(r,'steckdose_schalt'); if(!s) return;
      if(r.type==='kueche'){const k=s>=5?2:1;for(let i=0;i<k;i++) add({name:`Steckdosen ${r.name}${k>1?' '+(i+1):''}`,where:r.name,prot:B16,cable:'NYM-J 3×2,5',load:1.8,type:'socket'})}
      else if(r.type==='bad'||s>=7) add({name:`Steckdosen ${r.name}`,where:r.name,prot:B16,cable:'NYM-J 3×2,5',load:1.6,type:'socket'});
      else{ if(pn+s>8) flush(); pool.push(r.name); pn+=s; }
    });
    flush();
  });
  const DED={herd:{nm:'Herd / Kochfeld',prot:'FI/LS 3+N B16 · 30 mA Typ A',cable:'NYM-J 5×2,5',poles:3,te:4,load:3},
    backofen:{nm:'Backofen',prot:B16,cable:'NYM-J 3×2,5',load:3},gsp:{nm:'Geschirrspüler',prot:B16,cable:'NYM-J 3×2,5',load:2.2},
    wm:{nm:'Waschmaschine',prot:B16,cable:'NYM-J 3×2,5',load:2.2},trockner:{nm:'Trockner',prot:B16,cable:'NYM-J 3×2,5',load:2.5},
    wallbox:{nm:'Wallbox 11 kW',prot:'LS 3-pol nach Hersteller (11 kW = 3×16 A) + FI 4-pol Typ A mit DC-Erkennung in der Box, sonst Typ B',cable:'NYM-J 5×4 bis 5×6 (nach Länge)',poles:3,te:7,load:3.7}};
  allRooms(p).forEach(r=>{for(const k in DED){for(let i=0;i<n(r,k);i++){const d=DED[k];add({name:`${d.nm} (${r.name})`,where:r.name,...d,type:'ded'})}}});
  const outS=total(p,'steckdose',isOut)+total(p,'steckdose_schalt',isOut)+total(p,'tor');
  if(outS) add({name:'Außensteckdosen / Tor',where:'Außen',prot:B16,cable:'NYM-J 3×2,5 (außen: NYY-J)',load:1,type:'socket'});
  const outL=total(p,'licht',isOut)+total(p,'dimm',isOut)+total(p,'rollladen',isOut);
  if(outL) add({name:'Außenbeleuchtung',where:'Außen',prot:B10,cable:'NYM-J 3×1,5 (außen: NYY-J)',load:.3,type:'light'});
  const bus=p.system!=='shelly';
  if(bus) add({name:`Steuerung ${SYS[p.system]} (Spannungsversorgung, Gateway)`,where:'Verteiler',prot:B10,cable:'im Verteiler',load:.1,type:'ctl'});
  if(bus&&total(p,'heizung')) add({name:'Heizungsaktor (Stellantriebe)',where:'Verteiler',prot:B10,cable:'NYM-J 3×1,5',load:.1,type:'ctl'});
  if(total(p,'netzwerk')+total(p,'tv')) add({name:'Netzwerk / Medienverteiler',where:'Technik',prot:B16,cable:'NYM-J 3×2,5',load:.3,type:'socket'});
  // Phasen: 3-polige auf alle, Rest gierig nach Last
  const ph={L1:0,L2:0,L3:0};
  out.filter(c=>c.poles===3).forEach(c=>{c.phase='L123';for(const k in ph) ph[k]+=c.load/3});
  out.filter(c=>c.poles!==3).slice().sort((a,b)=>b.load-a.load).forEach(c=>{const k=Object.keys(ph).sort((a,b)=>ph[a]-ph[b])[0];c.phase=k;ph[k]+=c.load});
  out.forEach((c,i)=>c.nr='F'+(i+1));
  return {list:out,ph};
}

/* ---------- Kanäle und Aktoren ---------- */
function channels(p){
  const c={switch:total(p,'licht')+total(p,'steckdose_schalt'),dim:total(p,'dimm'),blind:total(p,'rollladen'),heat:total(p,'heizung'),gate:total(p,'tor'),taster:total(p,'taster'),praes:total(p,'praesenz')};
  return c;
}
function actuators(p){
  const c=channels(p),ce=Math.ceil,list=[];
  const A=(name,qty,ch,te,note)=>{if(qty>0) list.push({name,qty,ch,te,note})};
  if(p.system==='luxor'){
    A('LUXORliving S4 Schaltaktor 4-fach',ce(c.switch/4),c.switch,4);
    A('LUXORliving D2 Dimmaktor 2-fach',ce(c.dim/2),c.dim,4);
    A('LUXORliving J4 Jalousieaktor 4-fach',ce(c.blind/4),c.blind,4);
    A('LUXORliving H6 Heizungsaktor 6-fach',ce(c.heat/6),c.heat,4);
    A('Torsteuerung über Schaltkanal (potentialfrei)',c.gate,c.gate,0,'oder Shelly 1 im Torantrieb');
    const dev=list.reduce((s,a)=>s+a.qty,0)+c.taster+c.praes+1;
    A('LUXORliving P640 Spannungsversorgung',Math.max(1,ce(dev/64)),null,4,`${dev} Busteilnehmer`);
    A('LUXORliving IP1 Systemzentrale',1,null,4,'Verbindung zum Hub');
  }else if(p.system==='knx'){
    A('KNX Schaltaktor 8-fach',ce(c.switch/8),c.switch,8);
    A('KNX Dimmaktor 4-fach (LED)',ce(c.dim/4),c.dim,8);
    A('KNX Jalousieaktor 8-fach',ce(c.blind/8),c.blind,8);
    A('KNX Heizungsaktor 6-fach',ce(c.heat/6),c.heat,4);
    A('Torsteuerung über Schaltkanal (potentialfrei)',c.gate,c.gate,0);
    const dev=list.reduce((s,a)=>s+a.qty,0)+c.taster+c.praes+1;
    A('KNX Spannungsversorgung 640 mA',Math.max(1,ce(dev/64)),null,4,`${dev} Busteilnehmer`);
    A('KNX IP-Schnittstelle',1,null,2,'Verbindung zum Hub');
  }else{
    A('Shelly Pro 4PM (4 Kanäle, Hutschiene)',ce(c.switch/4),c.switch,4);
    A('Shelly Pro Dimmer 2PM (2 Kanäle, Hutschiene)',ce(c.dim/2),c.dim,4);
    A('Shelly Pro Dual Cover PM (2 Rollläden, Hutschiene)',ce(c.blind/2),c.blind,4);
    A('Shelly 1 Gen3 (im Torantrieb)',c.gate,c.gate,0);
    if(c.heat) list.push({name:'Heizung: Raumregelung über das Heizsystem (nicht Shelly)',qty:c.heat,ch:c.heat,te:0,note:'separat planen'});
  }
  return {list,c};
}

/* ---------- Einkaufsliste ---------- */
function shopping(p){
  const G=[],grp=(name)=>{const g={name,items:[]};G.push(g);return g};
  const it=(g,name,qty,unit,note)=>{if(qty>0) g.items.push({name,qty,unit:unit||'Stk',note:note||''})};
  const {list:cs}=circuits(p), act=actuators(p), bus=p.system!=='shelly';
  const v=grp('Verteiler und Schutz');
  const single=cs.filter(c=>c.poles===1).length, three=cs.filter(c=>c.poles===3&&c.type!=='ded'||c.name.startsWith('Herd')).length, wb=cs.filter(c=>c.name.startsWith('Wallbox')).length;
  it(v,'FI/LS-Schalter 1+N kompakt (1 TE), 30 mA Typ A',single,'Stk','B10 für Licht/Rollläden, B16 für Steckdosen');
  it(v,'FI/LS-Schalter 3+N B16, 30 mA Typ A',three,'Stk','Herd / Kochfeld');
  it(v,'Leitungsschutzschalter 3-polig für Wallbox',wb,'Stk','Größe nach Hersteller');
  it(v,'FI-Schutzschalter 4-polig 40 A (Typ A mit DC-Erkennung in Wallbox, sonst Typ B)',wb,'Stk');
  it(v,'Überspannungsschutz Typ 1+2 (Kombiableiter)',1,'Stk');
  it(v,'Hauptschalter / Lasttrennschalter 3-polig',1,'Stk');
  const te=cs.reduce((s,c)=>s+c.te,0)+4+3+act.list.reduce((s,a)=>s+a.qty*a.te,0);
  const rows=Math.ceil(te*1.2/12);
  it(v,`Verteilerfeld mind. ${rows} Reihen à 12 TE`,1,'Stk',`ca. ${te} TE belegt + 20 % Reserve (TE nach Datenblatt prüfen)`);
  it(v,'Phasenschiene, N- und PE-Klemmen, Beschriftung',1,'Satz');
  const a=grp(`Steuerung (${SYS[p.system]})`);
  act.list.forEach(x=>it(a,x.name,x.qty,'Stk',x.ch!=null?`${x.ch} Kanäle${x.note?' · '+x.note:''}`:(x.note||'')));
  const c=act.c;
  if(bus){
    it(a,p.system==='luxor'?'Bus-Taster für LUXORliving (z. B. Theben iON)':'KNX Tastsensor',c.taster,'Stk');
    it(a,p.system==='luxor'?'Präsenzmelder für LUXORliving (Theben)':'KNX Präsenzmelder',c.praes,'Stk');
  }else{
    it(a,'Taster UP (konventionell, an Shelly-Eingang)',c.taster,'Stk');
    it(a,'Präsenzmelder 230 V oder Shelly BLU Motion',c.praes,'Stk');
  }
  it(a,'Raspberry Pi mit Liesenberg Home Hub',1,'Stk','falls noch nicht vorhanden');
  const s=grp('Schalterprogramm und Dosen');
  const inS=total(p,'steckdose',r=>!isOut(r))+total(p,'steckdose_schalt',r=>!isOut(r)), outSock=total(p,'steckdose',isOut)+total(p,'steckdose_schalt',isOut);
  it(s,'Schuko-Steckdose Einsatz + Abdeckung',inS);
  it(s,'Schuko-Steckdose AP IP44 (außen)',outSock);
  it(s,'Datendose 2× RJ45 Cat.6A',total(p,'netzwerk'));
  it(s,'Antennendose TV/SAT (Enddose)',total(p,'tv'));
  if(!bus) it(s,'Taster-Einsatz + Wippe',c.taster);
  const frames=inS+total(p,'netzwerk')+total(p,'tv')+c.taster;
  it(s,'Rahmen (1-fach gezählt, Mehrfachrahmen nach Montageplan)',frames);
  it(s,'Geräte-Verbindungsdose tief (Ø 68 mm)',inS+total(p,'netzwerk')+total(p,'tv')+c.taster,'Stk','tief, Platz für Bus/Shelly');
  it(s,'Deckendose / Leuchtenauslass',total(p,'licht')+total(p,'dimm')+c.praes);
  it(s,'Leuchtmittel / Leuchten',total(p,'licht')+total(p,'dimm'),'Stk','Auswahl durch Bauherrschaft; Dimmlicht: dimmbare LED');
  // Leitungen (grobe Schätzung)
  const L=[];
  p.floors.forEach((f,fi)=>f.rooms.forEach(r=>L.push({r,len:8+fi*4})));
  let m15=0,m25=0,m515=0,m525=0,mbus=0,mcat=0,mkoax=0;
  L.forEach(({r,len})=>{
    m15+=(n(r,'licht')+n(r,'dimm'))*len; if(!bus) m15+=n(r,'taster')*4;
    m515+=n(r,'rollladen')*len;
    m25+=(n(r,'steckdose')+n(r,'steckdose_schalt'))*5+(n(r,'backofen')+n(r,'gsp')+n(r,'wm')+n(r,'trockner')+n(r,'tor'))*(len+4);
    m525+=n(r,'herd')*(len+4);
    if(bus) mbus+=(n(r,'taster')+n(r,'praesenz'))*10;
    mcat+=n(r,'netzwerk')*2*(len+6); mkoax+=n(r,'tv')*(len+8);
  });
  m25+=cs.filter(c=>c.type==='socket').length*12;
  const ring=(m,sz)=>Math.ceil(m*1.15/sz);
  const l=grp('Leitungen (grobe Schätzung + 15 %)');
  it(l,'NYM-J 3×1,5 mm²',ring(m15,50),'Ring 50 m',`ca. ${Math.round(m15*1.15)} m`);
  it(l,'NYM-J 5×1,5 mm² (Rollläden)',ring(m515,50),'Ring 50 m',`ca. ${Math.round(m515*1.15)} m`);
  it(l,'NYM-J 3×2,5 mm²',ring(m25,50),'Ring 50 m',`ca. ${Math.round(m25*1.15)} m`);
  it(l,'NYM-J 5×2,5 mm² (Herd)',m525?Math.ceil(m525*1.15):0,'m');
  if(total(p,'wallbox')) it(l,'NYM-J 5×6 mm² (Wallbox, Querschnitt nach Länge)',total(p,'wallbox')*20,'m','Annahme 20 m');
  it(l,'Busleitung J-Y(St)Y 2×2×0,8',ring(mbus,100),'Ring 100 m',`ca. ${Math.round(mbus*1.15)} m`);
  it(l,'Datenkabel Cat.7 (2 Leitungen je Dose)',ring(mcat,100),'Ring 100 m',`ca. ${Math.round(mcat*1.15)} m`);
  it(l,'Koaxkabel 120 dB',ring(mkoax,100),'Ring 100 m',`ca. ${Math.round(mkoax*1.15)} m`);
  it(l,'Leerrohr M20 / M25 für Medien',total(p,'netzwerk')+total(p,'tv')?Math.ceil((mcat/2+mkoax)*1.1):0,'m');
  return G.filter(g=>g.items.length);
}

/* ---------- Export für den Hub ---------- */
function hubExport(p){
  const floors=p.floors.map(f=>({name:f.name,rooms:f.rooms.map(r=>{
    const devices=[],BASE={light:'Licht',dimmer:'Licht',blind:'Rollladen',heating:'Heizung',gate:'Tor',other:'Gerät'};
    const tot={},seen={},bn=d=>d.base||BASE[d.kind];
    DEV.filter(d=>d.kind).forEach(d=>{const b=bn(d);tot[b]=(tot[b]||0)+n(r,d.k)});
    DEV.filter(d=>d.kind).forEach(d=>{const c=n(r,d.k),b=bn(d);for(let i=0;i<c;i++){
      seen[b]=(seen[b]||0)+1; const no=tot[b]>1?' '+seen[b]:'';
      devices.push({id:`plan:${slug(f.name)}:${slug(r.name)}:${slug(b)}${no?'-'+seen[b]:''}`,name:`${r.name} ${b}${no}`,kind:d.kind,planned:true});
    }});
    return {name:r.name,type:r.type,area_m2:+r.area||null,devices};
  })}));
  const {list}=circuits(p);
  return {format:'liesenberg-home-plan',version:1,generated:new Date().toISOString(),
    home_name:p.name,backend:p.system==='knx'?'knx':p.system,ausstattungswert:p.aw,floors,
    circuits:list.map(c=>({nr:c.nr,name:c.name,where:c.where,protection:c.prot,cable:c.cable,phase:c.phase})),
    hinweis:'Planungsstand. Geräte-IDs werden beim Einlernen im Hub den echten Kanälen zugeordnet.'};
}

/* ---------- Beispiel ---------- */
function examplePlan(){
  const R=(name,type,area,windows,aw)=>{const r={id:uid(),name,type,area,windows,dev:{}};r.dev=rec(r,aw);return r};
  const aw=2;
  return {name:'Musterhaus (Beispiel)',adresse:'',aw,system:'luxor',example:true,floors:[
    {id:uid(),name:'EG',rooms:[R('Wohnzimmer','wohnen',32,3,aw),R('Küche','kueche',14,1,aw),R('Esszimmer','essen',14,2,aw),R('Flur','flur',9,1,aw),R('WC','wc',3,1,aw),R('Hauswirtschaft','hwr',7,1,aw)]},
    {id:uid(),name:'OG',rooms:[R('Schlafzimmer','schlafen',16,2,aw),R('Kind 1','kind',12,1,aw),R('Kind 2','kind',12,1,aw),R('Bad','bad',10,1,aw),R('Büro','arbeit',10,1,aw),R('Flur OG','flur',7,0,aw)]},
    {id:uid(),name:'Außen',rooms:[R('Terrasse','aussen',0,0,aw),R('Garage','garage',18,0,aw)]}
  ]};
}
function blankPlan(){return {name:'Neuer Plan',adresse:'',aw:2,system:'luxor',floors:[{id:uid(),name:'EG',rooms:[]}]}}


/* ---------- Reiter */
function devRow(r,d,recv,fi,ri){
  const v=n(r,d.k),rv=recv[d.k]||0,low=v<rv;
  return `<div class="dev"><span class="code" title="${esc(d.l)}">${d.c}</span><span>${esc(d.l)}</span>
  <span class="step"><button aria-label="weniger" data-dec="${fi}:${ri}:${d.k}">−</button><span>${v}</span><button aria-label="mehr" data-inc="${fi}:${ri}:${d.k}">+</button></span>
  <span class="rec${low?' low':''}" title="Richtwert für Ausstattungswert">${rv?'Empf. '+rv:''}</span></div>`;
}
function tabRooms(t,p){
  let h='';
  h+=`<div class="row" style="margin-bottom:16px"><button class="btn" data-act="allrec">Alle Räume auf Empfehlung setzen</button><span class="muted" style="font-size:13px">Orange markiert: weniger als der Richtwert.</span></div>`;
  p.floors.forEach((f,fi)=>{
    h+=`<section class="floor"><div class="floorhead"><input type="text" aria-label="Etage" data-floor="${fi}" value="${esc(f.name)}">
      <button class="btn small" data-addroom="${fi}">Raum hinzufügen</button>${f.rooms.length?'':`<button class="btn small ghost" data-rmfloor="${fi}">Etage löschen</button>`}</div><div class="rooms">`;
    if(!f.rooms.length) h+=`<div class="empty">Noch keine Räume auf dieser Etage.</div>`;
    f.rooms.forEach((r,ri)=>{
      const rv=rec(r,p.aw);
      const extra=DEV.filter(d=>!d.core&&(n(r,d.k)||rv[d.k]));
      const addable=DEV.filter(d=>!d.core&&!extra.includes(d));
      h+=`<article class="room"><div class="roomhead"><input type="text" class="name" aria-label="Raumname" data-rname="${fi}:${ri}" value="${esc(r.name)}"><button class="btn small ghost" data-rmroom="${fi}:${ri}" aria-label="Raum löschen">✕</button></div>
      <div class="roommeta"><select aria-label="Raumtyp" data-rtype="${fi}:${ri}">${Object.entries(RT).map(([k,v])=>`<option value="${k}"${k===r.type?' selected':''}>${v.n}</option>`).join('')}</select>
      <label>m² <input type="number" min="0" step="0.5" data-rarea="${fi}:${ri}" value="${+r.area||0}"></label>
      <label>Fenster <input type="number" min="0" data-rwin="${fi}:${ri}" value="${+r.windows||0}"></label></div>
      <div class="devs">${DEV.filter(d=>d.core).concat(extra).map(d=>devRow(r,d,rv,fi,ri)).join('')}</div>
      <div class="roomfoot"><button class="btn small" data-recroom="${fi}:${ri}">Empfehlung übernehmen</button>
      ${addable.length?`<select aria-label="Anschluss hinzufügen" data-adddev="${fi}:${ri}"><option value="">+ Anschluss</option>${addable.map(d=>`<option value="${d.k}">${esc(d.l)}</option>`).join('')}</select>`:''}</div></article>`;
    });
    h+=`</div></section>`;
  });
  h+=`<button class="btn" data-act="addfloor">Etage hinzufügen</button>`;
  t.innerHTML=h;
}
function tabCircuits(t,p){
  const {list,ph}=circuits(p),act=actuators(p);
  const te=list.reduce((s,c)=>s+c.te,0)+7+act.list.reduce((s,a)=>s+a.qty*a.te,0);
  const max=Math.max(ph.L1,ph.L2,ph.L3,1);
  t.innerHTML=`<div class="stats">
    <div class="stat"><b class="mono">${list.length}</b><span>Stromkreise</span></div>
    <div class="stat"><b class="mono">${te}</b><span>Teilungseinheiten belegt</span></div>
    <div class="stat"><b class="mono">${Math.ceil(te*1.2/12)}</b><span>Reihen à 12 TE (mit 20 % Reserve)</span></div>
    <div class="stat"><b class="mono">${act.list.filter(a=>a.ch!=null).reduce((s,a)=>s+a.ch,0)}</b><span>Aktorkanäle</span></div></div>
  <p class="note">Vorschlag zur Abstimmung mit der Elektrofachkraft. Absicherung, Querschnitte und FI-Aufteilung prüft und legt sie fest.</p>
  <div class="grid2" style="margin-top:14px">
   <div class="card" style="grid-column:1/-1"><h3 style="margin-bottom:8px">Stromkreisliste</h3><div class="tablewrap"><table>
    <thead><tr><th>Nr.</th><th>Stromkreis</th><th>Schutz</th><th>Leitung</th><th>Phase</th></tr></thead>
    <tbody>${list.map(c=>`<tr><td class="mono">${c.nr}</td><td>${esc(c.name)}</td><td>${esc(c.prot)}</td><td class="mono" style="font-size:12.5px">${esc(c.cable)}</td><td><span class="ph ${c.phase}">${c.phase==='L123'?'L1–L3':c.phase}</span></td></tr>`).join('')}</tbody></table></div></div>
   <div class="card"><h3 style="margin-bottom:8px">Phasenaufteilung (geschätzte Last)</h3>
    ${['L1','L2','L3'].map(k=>`<div class="row" style="margin:8px 0"><span class="ph ${k}" style="width:2.6em;text-align:center">${k}</span><div class="bar" style="flex:1"><i style="width:${ph[k]/max*100}%;background:var(--${k.toLowerCase()})"></i></div><span class="mono" style="width:4.5em;text-align:right">${ph[k].toFixed(1)} kW</span></div>`).join('')}
    <p class="muted" style="font-size:13px">Gleichzeitigkeit nicht berücksichtigt; dient nur zum gleichmäßigen Verteilen.</p></div>
   <div class="card"><h3 style="margin-bottom:8px">Aktoren ${SYS[p.system]}</h3><div class="tablewrap"><table><thead><tr><th>Gerät</th><th>Kanäle</th><th>Anz.</th></tr></thead>
    <tbody>${act.list.map(a=>`<tr><td>${esc(a.name)}${a.note?`<div class="muted" style="font-size:12.5px">${esc(a.note)}</div>`:''}</td><td class="num">${a.ch??'–'}</td><td class="num">${a.qty}</td></tr>`).join('')||'<tr><td colspan="3" class="muted">Noch keine schaltbaren Geräte geplant.</td></tr>'}</tbody></table></div></div>
  </div>`;
}
function listText(p,G){return [`Einkaufsliste – ${p.name} (${SYS[p.system]}, Ausstattungswert ${p.aw})`,''].concat(G.flatMap(g=>[g.name.toUpperCase(),...g.items.map(i=>`${i.qty} ${i.unit}  ${i.name}${i.note?'  ('+i.note+')':''}`),''])).concat(['Planungshilfe – Mengen und Artikel mit der Elektrofachkraft abstimmen.']).join('\n')}
function listCSV(G){const q=s=>'"'+String(s).replace(/"/g,'""')+'"';return ['Gruppe;Menge;Einheit;Artikel;Hinweis'].concat(G.flatMap(g=>g.items.map(i=>[g.name,i.qty,i.unit,i.name,i.note].map(q).join(';')))).join('\n')}
function tabList(t,p){
  const G=shopping(p);
  t.innerHTML=`<div class="row" style="margin-bottom:12px"><button class="btn primary" data-act="copylist">Als Text kopieren</button><button class="btn" data-act="csv">CSV speichern</button><span class="muted" style="font-size:13px">Mengen ohne Gewähr, Leitungslängen grob geschätzt.</span></div>
  ${G.map(g=>`<div class="group"><h3>${esc(g.name)}</h3><div class="tablewrap"><table><thead><tr><th style="width:5em">Menge</th><th style="width:7em">Einheit</th><th>Artikel</th><th>Hinweis</th></tr></thead><tbody>
   ${g.items.map(i=>`<tr><td class="num">${i.qty}</td><td>${esc(i.unit)}</td><td>${esc(i.name)}</td><td class="muted">${esc(i.note)}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}`;
}
function tabExport(t,p){
  const j=hubExport(p),cnt=j.floors.reduce((s,f)=>s+f.rooms.reduce((a,r)=>a+r.devices.length,0),0);
  t.innerHTML=`<div class="grid2"><div class="card"><h3>Haus für Liesenberg Home</h3>
   <p>Der Export enthält ${j.floors.length} Etagen, ${j.floors.reduce((s,f)=>s+f.rooms.length,0)} Räume und ${cnt} steuerbare Geräte im Aufbau des Hubs (Etagen → Räume → Geräte), dazu die Stromkreisliste.</p>
   <p class="muted" style="font-size:13.5px">Die Geräte sind als „geplant“ markiert. Beim Einrichten im Hub werden sie den echten Kanälen von ${SYS[p.system]} zugeordnet. Import im Hub: Einrichtungsseite → Reiter „Plan“ → Datei hochladen, dann jedem geplanten Gerät das echte Gerät zuordnen (ab dem Hub-Update mit Plan-Import).</p>
   <div class="row"><button class="btn primary" data-act="savejson">Datei speichern</button><button class="btn" data-act="copyjson">JSON kopieren</button></div></div>
   <div class="card"><h3>Vorschau</h3><pre>${esc(JSON.stringify(j,null,2))}</pre></div></div>`;
}
