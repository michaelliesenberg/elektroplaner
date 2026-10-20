"use strict";
/* Grundriss: hochladen (Bild oder PDF), Maßstab, Verteiler, Räume antippen (Wände werden erkannt),
   Anschlüsse automatisch vorschlagen und verschieben. Koordinaten in Pixeln des gespeicherten Bildes. */
const ED={tool:'room',scalePts:[],scaleM:'',pinsFor:null,pending:null,addK:'steckdose',zoom:1,drag:null,busy:false};
const MAXPX=1600;

/* ---------- Laden */
async function loadPlanFile(file){
  let src;
  if(file.type==='application/pdf'||/\.pdf$/i.test(file.name)){
    const pdfjs=await import(new URL('vendor/pdfjs/pdf.min.mjs',location.href).href);
    pdfjs.GlobalWorkerOptions.workerSrc=new URL('vendor/pdfjs/pdf.worker.min.mjs',location.href).href;
    const doc=await pdfjs.getDocument({data:await file.arrayBuffer()}).promise;
    const page=await doc.getPage(1),v0=page.getViewport({scale:1});
    const vp=page.getViewport({scale:MAXPX/Math.max(v0.width,v0.height)});
    src=document.createElement('canvas');src.width=Math.round(vp.width);src.height=Math.round(vp.height);
    const cx=src.getContext('2d');cx.fillStyle='#fff';cx.fillRect(0,0,src.width,src.height);
    await page.render({canvasContext:cx,viewport:vp}).promise;
  }else{
    if(!/^image\//.test(file.type)) throw new Error('Bitte ein Bild (JPG, PNG) oder PDF wählen');
    src=await new Promise((ok,bad)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>bad(new Error('Bild lässt sich nicht öffnen'));i.src=URL.createObjectURL(file)});
  }
  const W=src.naturalWidth||src.width,H=src.naturalHeight||src.height,k=Math.min(1,MAXPX/Math.max(W,H));
  const c=document.createElement('canvas');c.width=Math.round(W*k);c.height=Math.round(H*k);
  const cx=c.getContext('2d');cx.fillStyle='#fff';cx.fillRect(0,0,c.width,c.height);cx.drawImage(src,0,0,c.width,c.height);
  return {img:c.toDataURL('image/jpeg',0.8),w:c.width,h:c.height,scale:null,board:null};
}

/* ---------- Wände erkennen: Lücken bis Türbreite schließen (Dilatation + Erosion), dann vom angetippten Punkt aus füllen */
const maskCache=new Map();
function dilate(src,w,h,rad){
  const tmp=new Uint8Array(w*h),out=new Uint8Array(w*h);
  for(let y=0;y<h;y++){let s=0;const row=y*w;
    for(let x=-rad;x<w;x++){const a=x+rad,b=x-rad-1;if(a<w)s+=src[row+a];if(b>=0)s-=src[row+b];if(x>=0)tmp[row+x]=s>0?1:0}}
  for(let x=0;x<w;x++){let s=0;
    for(let y=-rad;y<h;y++){const a=y+rad,b=y-rad-1;if(a<h)s+=tmp[a*w+x];if(b>=0)s-=tmp[b*w+x];if(y>=0)out[y*w+x]=s>0?1:0}}
  return out;
}
// Schrift, Möbel-Symbole und Bemaßungszahlen entfernen: zusammenhängende dunkle Flecken, die kleiner als ~0,6 m sind
function dropSmall(wall,w,h,max){
  const seen=new Uint8Array(w*h),q=new Int32Array(w*h);
  for(let s0=0;s0<w*h;s0++){if(!wall[s0]||seen[s0])continue;
    let qh=0,qt=0,x0=w,x1=0,y0=h,y1=0;q[qt++]=s0;seen[s0]=1;
    while(qh<qt){const i=q[qh++],cx=i%w,cy=(i-cx)/w;if(cx<x0)x0=cx;if(cx>x1)x1=cx;if(cy<y0)y0=cy;if(cy>y1)y1=cy;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=cx+dx,yy=cy+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;const j=yy*w+xx;if(wall[j]&&!seen[j]){seen[j]=1;q[qt++]=j}}}
    if(x1-x0<max&&y1-y0<max) for(let k=0;k<qt;k++) wall[q[k]]=0;
  }
}
async function wallMask(f,rad){
  const key=f.id+':'+f.plan.img.length+':'+rad;
  if(maskCache.has(key)) return maskCache.get(key);
  const im=await new Promise((ok,bad)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=bad;i.src=f.plan.img});
  const w=f.plan.w,h=f.plan.h,c=document.createElement('canvas');c.width=w;c.height=h;
  const cx=c.getContext('2d',{willReadFrequently:true});cx.drawImage(im,0,0,w,h);
  const px=cx.getImageData(0,0,w,h).data,wall=new Uint8Array(w*h);
  for(let i=0;i<w*h;i++){const g=.3*px[i*4]+.59*px[i*4+1]+.11*px[i*4+2];wall[i]=g<150?1:0}
  dropSmall(wall,w,h,Math.max(6,Math.round((f.plan.scale||Math.max(w,h)/15)*.6)));
  const d=dilate(wall,w,h,rad);for(let i=0;i<w*h;i++)d[i]=d[i]?0:1;  // invertiert
  const e=dilate(d,w,h,rad);for(let i=0;i<w*h;i++)e[i]=e[i]?0:1;     // geschlossene Wände
  if(maskCache.size>6) maskCache.delete(maskCache.keys().next().value);
  maskCache.set(key,e);return e;
}
async function detectRoom(f,x,y,block){
  const w=f.plan.w,h=f.plan.h,sc=f.plan.scale||Math.max(w,h)/15,minA=sc*sc*(block?.5:.8);let best=null,outside=false,swallow=false;
  // block: bereits erkannte Räume zählen als Wand (für schmale Räume an der Beschriftung, deren Tür offen bleibt)
  for(const fac of block?[.4,.3,.22,.15]:[.65,.57,.5,.4,.3]){
    const rad=Math.max(2,Math.round(fac*sc));let m=await wallMask(f,rad);
    if(block){m=m.slice();for(const r of f.rooms){if(!r.rect)continue;const g=Math.round(sc*.1);for(let yy=Math.max(0,r.rect.y-g);yy<Math.min(h,r.rect.y+r.rect.h+g);yy++)m.fill(1,yy*w+Math.max(0,r.rect.x-g),yy*w+Math.min(w,r.rect.x+r.rect.w+g))}}
    let sx=Math.round(x),sy=Math.round(y);
    if(sx<0||sy<0||sx>=w||sy>=h) return {error:'Bitte auf den Grundriss tippen.'};
    if(m[sy*w+sx]&&fac>.3&&!block) continue;
    if(m[sy*w+sx]){let ok=false;for(let r=2;r<=rad*2&&!ok;r+=2)for(const [dx,dy] of [[r,0],[-r,0],[0,r],[0,-r],[r,r],[-r,-r],[r,-r],[-r,r]]){const xx=sx+dx,yy=sy+dy;if(xx>=0&&yy>=0&&xx<w&&yy<h&&!m[yy*w+xx]){sx=xx;sy=yy;ok=true;break}}if(!ok)continue}
    const seen=new Uint8Array(w*h),q=new Int32Array(w*h);let qh=0,qt=0,cnt=0,x0=sx,x1=sx,y0=sy,y1=sy,leak=false;
    q[qt++]=sy*w+sx;seen[sy*w+sx]=1;
    while(qh<qt){const i=q[qh++],cx=i%w,cy=(i-cx)/w;cnt++;
      if(cx<x0)x0=cx;if(cx>x1)x1=cx;if(cy<y0)y0=cy;if(cy>y1)y1=cy;
      if(cx===0||cy===0||cx===w-1||cy===h-1){leak=true;break}
      const nb=[i-1,i+1,i-w,i+w];for(const j of nb){if(!seen[j]&&!m[j]){seen[j]=1;q[qt++]=j}}}
    if(leak){if(!best)outside=true;continue}
    if(cnt<minA) continue;
    if(f.rooms.some(r=>{if(!r.rect)return false;const cx=r.rect.x+r.rect.w/2,cy=r.rect.y+r.rect.h/2;return cx>x0&&cx<x1&&cy>y0&&cy<y1&&!(sx>r.rect.x&&sx<r.rect.x+r.rect.w&&sy>r.rect.y&&sy<r.rect.y+r.rect.h)})){swallow=true;continue}
    if(!best||cnt<best.cnt) best={cnt,rect:{x:x0,y:y0,w:x1-x0+1,h:y1-y0+1}};
  }
  if(best) return {rect:best.rect};
  if(swallow) return {error:'Die Wände sind hier nicht dicht genug für die Erkennung. Ziehe den Raum mit dem Finger als Rechteck auf.'};
  if(outside) return {error:'Hier ist kein geschlossener Raum. Tippe in einen Raum oder ziehe ihn als Rechteck auf.'};
  return {error:'Hier ist kein Raum zu erkennen. Tippe weiter in die Mitte oder ziehe den Raum als Rechteck auf.'};
}

// Alle geschlossenen Flächen auf einmal als Räume erkennen
async function detectAll(f){
  const sc=f.plan.scale,out=await regions(f,.55,sc*sc*1.5,Infinity,[]);
  // zweiter Durchgang mit kleinerem Radius nur für kleine Räume (WC, Abstellraum), die beim ersten zugelaufen sind
  const small=await regions(f,.42,sc*sc*1.2,sc*sc*4.5,out);
  return out.concat(small).sort((a,b)=>Math.round(a.rect.y/sc/2)-Math.round(b.rect.y/sc/2)||a.rect.x-b.rect.x);
}
async function regions(f,fac,minA,maxA,have){
  const w=f.plan.w,h=f.plan.h,sc=f.plan.scale,rad=Math.max(2,Math.round(fac*sc)),m=await wallMask(f,rad);
  const lab=new Uint8Array(w*h),q=new Int32Array(w*h),out=[];
  const inside=(r,o)=>r.x+r.w/2>o.x&&r.x+r.w/2<o.x+o.w&&r.y+r.h/2>o.y&&r.y+r.h/2<o.y+o.h;
  for(let s0=0;s0<w*h;s0++){if(m[s0]||lab[s0])continue;
    let qh=0,qt=0,x0=w,x1=0,y0=h,y1=0,edge=false;q[qt++]=s0;lab[s0]=1;
    while(qh<qt){const i=q[qh++],cx=i%w,cy=(i-cx)/w;if(cx<x0)x0=cx;if(cx>x1)x1=cx;if(cy<y0)y0=cy;if(cy>y1)y1=cy;
      if(cx===0||cy===0||cx===w-1||cy===h-1)edge=true;
      if(cx>0&&!m[i-1]&&!lab[i-1]){lab[i-1]=1;q[qt++]=i-1}if(cx<w-1&&!m[i+1]&&!lab[i+1]){lab[i+1]=1;q[qt++]=i+1}
      if(cy>0&&!m[i-w]&&!lab[i-w]){lab[i-w]=1;q[qt++]=i-w}if(cy<h-1&&!m[i+w]&&!lab[i+w]){lab[i+w]=1;q[qt++]=i+w}}
    if(edge||qt<minA||qt>maxA||qt>w*h*.6)continue;
    const r={x:x0,y:y0,w:x1-x0+1,h:y1-y0+1};
    if(f.rooms.some(o=>o.rect&&(inside(r,o.rect)||inside(o.rect,r)))||have.some(o=>inside(r,o.rect)||inside(o.rect,r)))continue;
    out.push({rect:r,area:qt/sc/sc});
  }
  return out;
}
// Raumtyp grob aus Größe und Form raten; der Nutzer prüft ihn danach
function guessTypes(list){
  const big=list.slice().sort((a,b)=>b.area-a.area);let sleep=0,kitchen=false;
  return list.map(o=>{const a=o.area,asp=Math.max(o.rect.w,o.rect.h)/Math.min(o.rect.w,o.rect.h);
    if(o===big[0]&&a>=15)return 'wohnen';
    if(a<4)return 'wc';
    if(asp>=2.2&&a<14)return 'flur';
    if(a<7)return 'bad';
    if(!kitchen&&a>=8&&a<=20&&o!==big[0]){kitchen=true;return 'kueche'}
    if(a<=20){return (sleep++)===0?'schlafen':'kind'}
    return 'essen';
  });
}
/* ---------- Raumnamen lesen: kostenlose Texterkennung (Tesseract) direkt im Browser, nichts wird hochgeladen */
const LABELS=[[/wohn/,'wohnen'],[/ess(en|zi)|^ess$/,'essen'],[/k[üu]e?ch|koch/,'kueche'],[/schlaf|eltern/,'schlafen'],[/kind/,'kind'],
  [/arbeit|b[üu]e?ro|office|studio/,'arbeit'],[/^wc$|g[äa]e?ste|toilet/,'wc'],[/bad|dusch/,'bad'],[/flur|diele|gang|eingang|windfang|treppe/,'flur'],
  [/hwr|hauswirt|wasch|technik|heiz/,'hwr'],[/abstell|keller|vorrat|speis|lager/,'keller'],[/garage|carport/,'garage'],[/terrass|balkon|loggia|garten/,'aussen'],[/zimmer|gast/,'sonst']];
function labelType(t){t=t.toLowerCase();for(const [re,k] of LABELS) if(re.test(t)) return k;return null}
let ocrWorker=null;
function loadScript(src){return new Promise((ok,bad)=>{const e=document.createElement('script');e.src=src;e.onload=ok;e.onerror=()=>bad(new Error('Texterkennung ließ sich nicht laden'));document.head.appendChild(e)})}
async function readLabels(f){
  if(f.plan.labels) return f.plan.labels;
  const base=new URL('vendor/tesseract/',location.href).href;
  if(!window.Tesseract) await loadScript(base+'tesseract.min.js');
  if(!ocrWorker) ocrWorker=await Tesseract.createWorker('deu',1,{workerPath:base+'worker.min.js',corePath:base,langPath:base+'lang'});
  const {data}=await ocrWorker.recognize(f.plan.img);
  const out=[];
  (data.words||[]).forEach(w=>{const t=(w.text||'').replace(/[^A-Za-zÄÖÜäöüß\-.]/g,'');if(t.length<2||w.confidence<55)return;
    if(!labelType(t))return;const b=w.bbox;out.push({t,x:Math.round((b.x0+b.x1)/2),y:Math.round((b.y0+b.y1)/2)})});
  f.plan.labels=out;return out;
}
function labelIn(f,R){const l=(f.plan.labels||[]).filter(q=>q.x>=R.x&&q.x<=R.x+R.w&&q.y>=R.y&&q.y<=R.y+R.h);return l[0]||null}
function nameFromLabel(t){t=t.replace(/[-.]+$/,'');return t.length<=3?t.toUpperCase():t[0].toUpperCase()+t.slice(1).toLowerCase()}
async function applyLabels(p,fi,onlyAuto){
  const f=p.floors[fi];let n_=0;
  try{await readLabels(f)}catch(e){toast('Raumnamen konnten nicht gelesen werden: '+errText(e));return 0}
  f.rooms.forEach(r=>{if(!r.rect||(onlyAuto&&!r.auto))return;const l=labelIn(f,r.rect);if(!l)return;
    const t=labelType(l.t);if(!t)return;r.type=t;r.name=nameFromLabel(l.t);r.windows=guessWindows(t,r.area);delete r.auto;
    r.dev=rec(r,p.aw);autoPlace(f,r);syncDev(r);if(isKonv(p))presetRoom(p.preset,r);n_++});
  return n_;
}
async function runLabels(){
  ED.busy=true;document.body.classList.add('busy');toast('Lese Raumnamen aus dem Grundriss …');
  try{const p=plan();delete p.floors[S.floor].plan.labels;const k=await applyLabels(p,S.floor,false);changed();
    toast(k?`${k} Raumnamen gelesen`:'Keine Raumnamen im Grundriss gefunden. Bitte die Raumtypen rechts wählen.')}
  finally{ED.busy=false;document.body.classList.remove('busy')}
}
async function autoRooms(p,fi){
  const f=p.floors[fi];if(!f.plan||!f.plan.scale)return 0;
  ED.busy=true;document.body.classList.add('busy');
  try{
    const found=await detectAll(f),types=guessTypes(found);
    found.forEach((o,i)=>{const t=types[i],r={id:uid(),name:uniqueName(f,RT[t].n),type:t,area:Math.round(o.area*2)/2,windows:guessWindows(t,o.area),rect:o.rect,dev:{},auto:true};
      r.dev=rec(r,p.aw);autoPlace(f,r);syncDev(r);if(isKonv(p))presetRoom(p.preset,r);f.rooms.push(r)});
    return found.length;
  }finally{ED.busy=false;document.body.classList.remove('busy')}
}
async function runAutoRooms(){
  const p=plan(),fi=S.floor;let n_=await autoRooms(p,fi);ED.tool='room';changed();
  if(!n_){if(!p.floors[fi].plan.board)setBoardAuto(p.floors[fi]);changed();toast('Keine Räume gefunden. Unter „Anpassen“ kannst du sie antippen oder aufziehen.');return}
  toast(`${n_} Räume erkannt, lese Raumnamen …`);
  ED.busy=true;document.body.classList.add('busy');
  try{let k=await applyLabels(p,fi,true);
    // Beschriftete Räume, die die Flächenerkennung übersehen hat: wie ein Antippen an der Beschriftung
    const f=p.floors[fi];
    for(const l of (f.plan.labels||[])){
      if(f.rooms.some(r=>r.rect&&l.x>=r.rect.x&&l.x<=r.rect.x+r.rect.w&&l.y>=r.rect.y&&l.y<=r.rect.y+r.rect.h))continue;
      const res=await detectRoom(f,l.x,l.y,true);if(!res.rect)continue;const t=labelType(l.t),area=rectArea(f,res.rect);if(!t||area<1)continue;
      const r={id:uid(),name:uniqueName(f,nameFromLabel(l.t)),type:t,area,windows:guessWindows(t,area),rect:res.rect,dev:{}};
      r.dev=rec(r,p.aw);autoPlace(f,r);syncDev(r);if(isKonv(p))presetRoom(p.preset,r);f.rooms.push(r);k++;n_++;
    }
    if(!f.plan.board) setBoardAuto(f);
    changed();toast(k===n_?`${n_} Räume erkannt und benannt.`:`${n_} Räume erkannt, ${k} davon benannt. Bitte rechts die übrigen Raumtypen prüfen.`)}
  finally{ED.busy=false;document.body.classList.remove('busy')}
}

/* ---------- Anschlüsse vorschlagen */
const symR=f=>Math.max(f.plan.w,f.plan.h)/80;
function perim(R,t){
  const P=2*(R.w+R.h);let d=((t%1)+1)%1*P;
  if(d<R.w) return {x:R.x+d,y:R.y}; d-=R.w;
  if(d<R.h) return {x:R.x+R.w,y:R.y+d}; d-=R.h;
  if(d<R.w) return {x:R.x+R.w-d,y:R.y+R.h}; d-=R.w;
  return {x:R.x,y:R.y+R.h-d};
}
function outerEdge(f,R){ // Wand, die am nächsten am Bildrand liegt = Außenwand (dort Fenster)
  const e=[['top',R.y],['right',f.plan.w-(R.x+R.w)],['bottom',f.plan.h-(R.y+R.h)],['left',R.x]];
  return e.sort((a,b)=>a[1]-b[1])[0][0];
}
function onEdge(R,edge,i,n){
  const t=(i+1)/(n+1);
  return edge==='top'?{x:R.x+R.w*t,y:R.y}:edge==='bottom'?{x:R.x+R.w*t,y:R.y+R.h}:edge==='left'?{x:R.x,y:R.y+R.h*t}:{x:R.x+R.w,y:R.y+R.h*t};
}
function autoPlace(f,r){
  const s=symR(f),m=s*1.7,R={x:r.rect.x+m,y:r.rect.y+m,w:Math.max(2,r.rect.w-2*m),h:Math.max(2,r.rect.h-2*m)};
  const items=[],put=(k,pt)=>items.push({id:uid(),k,x:Math.round(pt.x),y:Math.round(pt.y)});
  const N=k=>n(r,k);
  const ns=N('steckdose')+N('steckdose_schalt');
  for(let i=0;i<N('steckdose');i++) put('steckdose',perim(R,(i+.3)/ns));
  for(let i=0;i<N('steckdose_schalt');i++) put('steckdose_schalt',perim(R,(N('steckdose')+i+.3)/ns));
  const nm=N('netzwerk')+N('tv');
  for(let i=0;i<N('netzwerk');i++) put('netzwerk',perim(R,(i+.7)/Math.max(nm,1)+.05));
  for(let i=0;i<N('tv');i++) put('tv',perim(R,(N('netzwerk')+i+.7)/Math.max(nm,1)+.05));
  const nl=N('licht')+N('dimm'),long=R.w>=R.h,cx=R.x+R.w/2,cy=R.y+R.h/2;
  const lpos=i=>nl<=1?{x:cx,y:cy}:long?{x:R.x+R.w*(i+1)/(nl+1),y:cy}:{x:cx,y:R.y+R.h*(i+1)/(nl+1)};
  for(let i=0;i<N('dimm');i++) put('dimm',lpos(i));
  for(let i=0;i<N('licht');i++) put('licht',lpos(N('dimm')+i));
  for(let i=0;i<N('taster');i++) put('taster',perim(R,.97-i*.26));
  for(let i=0;i<N('praesenz');i++) put('praesenz',{x:cx+s*2.5,y:cy+s*2.5});
  const edge=outerEdge(f,r.rect);
  for(let i=0;i<N('rollladen');i++) put('rollladen',onEdge(R,edge,i,N('rollladen')));
  const inw=edge==='top'?[0,1]:edge==='bottom'?[0,-1]:edge==='left'?[1,0]:[-1,0];
  for(let i=0;i<N('heizung');i++){const q=onEdge(R,edge,i,N('heizung')+1);put('heizung',{x:q.x+inw[0]*s*2.4,y:q.y+inw[1]*s*2.4})}
  let di=0;const ded=DEV.filter(d=>!d.core).reduce((a,d)=>a+N(d.k),0);
  DEV.filter(d=>!d.core).forEach(d=>{for(let i=0;i<N(d.k);i++) put(d.k,perim(R,.55+(di++)/(ded*3)))});
  r.items=items;
}
function syncDev(r){const o={};(r.items||[]).forEach(i=>o[i.k]=(o[i.k]||0)+1);r.dev=o}
function addItem(f,r,k){
  const s=symR(f),cnt=(r.items||[]).filter(i=>i.k===k).length;
  r.items=r.items||[];r.items.push({id:uid(),k,x:Math.round(r.rect.x+r.rect.w/2+(cnt%4)*s*2.4-s*3.6),y:Math.round(r.rect.y+r.rect.h/2+s*3+Math.floor(cnt/4)*s*2.4)});syncDev(r);
}
function removeItem(r,k){const i=(r.items||[]).map(x=>x.k).lastIndexOf(k);if(i>=0)r.items.splice(i,1);syncDev(r)}
function rectArea(f,R){return f.plan&&f.plan.scale?Math.round(R.w*R.h/f.plan.scale/f.plan.scale*2)/2:0}
function guessWindows(type,area){if(['flur','wc','keller','garage','aussen'].includes(type))return type==='wc'?1:0;return Math.max(1,Math.round(area/12))}
function roomAt(f,pt){const c=f.rooms.filter(r=>r.rect&&pt.x>=r.rect.x&&pt.y>=r.rect.y&&pt.x<=r.rect.x+r.rect.w&&pt.y<=r.rect.y+r.rect.h);return c.sort((a,b)=>a.rect.w*a.rect.h-b.rect.w*b.rect.h)[0]}

/* ---------- Darstellung */
function setBoardAuto(f){
  const by=t=>f.rooms.find(r=>r.rect&&r.type===t);
  const r=by('hwr')||by('keller')||by('flur')||by('garage');
  if(r) f.plan.board={x:Math.round(r.rect.x+r.rect.w*.85),y:Math.round(r.rect.y+r.rect.h*.85)};
  else{const R=f.rooms.filter(x=>x.rect);if(R.length){const y1=Math.max(...R.map(x=>x.rect.y+x.rect.h)),x0=Math.min(...R.map(x=>x.rect.x));f.plan.board={x:x0+symR(f)*2,y:y1-symR(f)*2}}else f.plan.board={x:Math.round(f.plan.w/2),y:Math.round(f.plan.h/2)}}
  if(!plan().floors.some(x=>x.plan&&x.plan.main)) f.plan.main=true;
}
// Zwei Pins für den Maßstab: Startposition an den Außenkanten der Zeichnung (unten links und rechts)
function ensurePins(f){
  const key=f.id+':'+f.plan.img.length;if(ED.pinsFor===key&&ED.scalePts.length===2)return;
  ED.pinsFor=key;const w=f.plan.w,h=f.plan.h;ED.scalePts=[{x:Math.round(w*.15),y:Math.round(h*.85)},{x:Math.round(w*.85),y:Math.round(h*.85)}];
  const im=new Image();im.onload=()=>{if(ED.pinsFor!==key||ED.drag)return;
    const c=document.createElement('canvas');c.width=w;c.height=h;const cx=c.getContext('2d',{willReadFrequently:true});cx.drawImage(im,0,0,w,h);
    const px=cx.getImageData(0,0,w,h).data,col=new Uint32Array(w),row=new Uint32Array(h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;if(.3*px[i]+.59*px[i+1]+.11*px[i+2]<150){col[x]++;row[y]++}}
    const tc=h*.15,tr=w*.15;let x0=col.findIndex(v=>v>tc),x1=w-1-[...col].reverse().findIndex(v=>v>tc),y1=h-1-[...row].reverse().findIndex(v=>v>tr);
    if(x0<0||x1<=x0+w*.2||y1<0)return;
    ED.scalePts=[{x:x0,y:y1},{x:x1,y:y1}];if(document.getElementById('scaleLine')){movePinDom(0);movePinDom(1)}};
  im.src=f.plan.img;
}
function movePinDom(i){
  const q=ED.scalePts[i],g=document.querySelector(`[data-pin="${i}"]`),l=document.getElementById('scaleLine');
  if(g)g.setAttribute('transform',`translate(${q.x} ${q.y})`);if(l){l.setAttribute('x'+(i+1),q.x);l.setAttribute('y'+(i+1),q.y)}
}
function hintText(f){
  if(!f.plan.scale) return '<b>Maßstab:</b> Ziehe die zwei Pins an die Enden einer Strecke, deren Länge du kennst. Vorgeschlagen ist die Außenwand. Dann die Länge eingeben.';
  if(ED.edit){
    if(ED.tool==='room') return 'Tippe in einen fehlenden Raum oder ziehe ihn als Rechteck auf.';
    if(ED.tool==='move') return 'Ziehe Symbole an die richtige Stelle.';
    if(ED.tool==='add') return `Tippe in einen Raum, um dort „${esc(DEVK[ED.addK].l)}“ zu setzen.`;
    if(ED.tool==='erase') return 'Tippe auf ein Symbol, um es zu löschen.';
    if(ED.tool==='board') return 'Tippe dorthin, wo der Verteiler sitzt.';
  }
  const nr=f.rooms.filter(r=>r.rect).length,ni=f.rooms.reduce((a,r)=>a+(r.items||[]).length,0);
  return nr?`<b>Fertig:</b> ${nr} Räume und ${ni} Anschlüsse vorgeschlagen.`:'<b>Keine Räume gefunden.</b> Tippe unter „Anpassen“ in die Räume.';
}
function editorHTML(p,fi){
  const f=p.floors[fi],P=f.plan,s=symR(f),ready=!!P.scale;
  if(!ready) ED.tool='scale'; else if(ED.tool==='scale') ED.tool='room';
  const tools=[['room','Raum'],['move','Verschieben'],['add','Hinzufügen'],['erase','Löschen'],['board','Verteiler']];
  const rooms=f.rooms.map((r,ri)=>!r.rect?'':`<g class="ed-room${ED.sel===r.id?' sel':''}"><rect x="${r.rect.x}" y="${r.rect.y}" width="${r.rect.w}" height="${r.rect.h}" rx="${s/3}"/>
    <text x="${r.rect.x+s*.6}" y="${r.rect.y+s*1.6}" font-size="${s*1.15}" class="ed-rname">${esc(r.name)}</text></g>`).join('');
  const items=f.rooms.map((r,ri)=>(r.items||[]).map((it,ii)=>`<g class="ed-it k-${it.k}" data-item="${ri}:${ii}" transform="translate(${it.x} ${it.y})"><circle r="${s}"/><text font-size="${s*(DEVK[it.k].c.length>2?.72:.95)}" dy="${s*.34}">${DEVK[it.k].c}</text></g>`).join('')).join('');
  const board=P.board?`<g class="ed-board" transform="translate(${P.board.x} ${P.board.y})"><rect x="${-s*1.3}" y="${-s*1.3}" width="${s*2.6}" height="${s*2.6}" rx="${s/4}"/><text font-size="${s}" dy="${s*.35}">V</text></g>`:'';
  if(!ready) ensurePins(f);
  const sp=!ready&&ED.scalePts.length===2?`<line id="scaleLine" class="ed-sl" x1="${ED.scalePts[0].x}" y1="${ED.scalePts[0].y}" x2="${ED.scalePts[1].x}" y2="${ED.scalePts[1].y}"/>`+ED.scalePts.map((q,i)=>`<g class="ed-pin" data-pin="${i}" transform="translate(${q.x} ${q.y})"><circle class="hit" r="${s*2.2}"/><circle class="ring" r="${s*1.5}"/><path class="cross" d="M${-s*2.1} 0H${s*2.1}M0 ${-s*2.1}V${s*2.1}"/><text y="${-s*2.2}" font-size="${s*1.4}">${i?'B':'A'}</text></g>`).join(''):'';
  const pend=ED.pending&&ED.pending.fi===fi?`<rect class="ed-pend" x="${ED.pending.rect.x}" y="${ED.pending.rect.y}" width="${ED.pending.rect.w}" height="${ED.pending.rect.h}"/>`:'';
  return `<div class="ed">
   <div class="ed-hint"><div class="ed-hintrow"><span>${hintText(f)}</span>
     ${ready&&!ED.edit?`<span class="ed-hintbtns"><button class="btn small ghost" data-ed="edit">Anpassen</button><button class="btn primary" data-tab="art">Weiter →</button></span>`:''}
     ${ready&&ED.edit?`<span class="ed-hintbtns"><button class="btn primary small" data-ed="editdone">Fertig</button></span>`:''}</div>
    ${!ready?`<form id="scaleForm" class="row" style="margin-top:8px"><span>Von A bis B:</span><input type="text" inputmode="decimal" id="scaleM" placeholder="z. B. 10,5" required style="width:7em" value="${esc(ED.scaleM||'')}"> <span>Meter</span><button class="btn primary small" type="submit">OK</button><button class="btn small ghost" type="button" data-ed="scalereset">Pins zurücksetzen</button></form>`:''}</div>
   ${ready&&ED.edit?`<div class="ed-tools"><div class="seg" role="group">${tools.map(([k,l])=>`<button data-tool="${k}" aria-pressed="${ED.tool===k}">${l}</button>`).join('')}</div>
     ${ED.tool==='add'?`<select id="edAddK" aria-label="Was hinzufügen">${DEV.map(d=>`<option value="${d.k}"${d.k===ED.addK?' selected':''}>${esc(d.l)}</option>`).join('')}</select>`:''}
     <span class="ed-zoom"><button class="btn small" data-ed="zoomout" aria-label="Verkleinern">−</button><button class="btn small" data-ed="zoomin" aria-label="Vergrößern">+</button></span></div>
     <div class="row ed-more"><button class="btn small ghost" data-ed="autorooms">Räume neu erkennen</button><button class="btn small ghost" data-ed="labels">Raumnamen lesen</button><button class="btn small ghost" data-ed="rescale">Maßstab neu</button><button class="btn small ghost danger" data-ed="rmplan">Grundriss entfernen</button></div>`:''}
   <div class="ed-wrap"><svg id="plansvg" class="ed-svg tool-${ready&&!ED.edit?'view':ED.tool}" viewBox="0 0 ${P.w} ${P.h}" style="width:${ED.zoom*100}%" role="img" aria-label="Grundriss ${esc(f.name)}">
     <image href="${P.img}" x="0" y="0" width="${P.w}" height="${P.h}"/>${rooms}${pend}${board}${items}${sp}<rect id="dragrect" class="ed-pend" x="0" y="0" width="0" height="0" visibility="hidden"/></svg></div>
  </div>`;
}
function pendingHTML(p,fi){
  const pd=ED.pending; if(!pd||pd.fi!==fi) return '';
  const f=p.floors[fi],area=rectArea(f,pd.rect);
  return `<form id="pendForm" class="room pend"><b>Neuer Raum erkannt${area?` · ca. ${String(area).replace('.',',')} m²`:''}</b>
   <div class="roommeta"><select id="pdType" aria-label="Raumtyp">${Object.entries(RT).map(([k,v])=>`<option value="${k}"${k===pd.type?' selected':''}>${v.n}</option>`).join('')}</select>
   <input type="text" id="pdName" aria-label="Raumname" value="${esc(pd.name)}" style="flex:1;min-width:8em"></div>
   <label class="roommeta">Fenster <input type="number" min="0" id="pdWin" value="${pd.windows}"></label>
   <div class="row"><button class="btn primary" type="submit">Übernehmen</button><button class="btn ghost" type="button" data-ed="pendno">Verwerfen</button></div></form>`;
}

/* ---------- Bedienung */
function svgPt(svg,e){const pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;const q=pt.matrixTransform(svg.getScreenCTM().inverse());return {x:Math.round(q.x),y:Math.round(q.y)}}
function curFloor(){return plan().floors[S.floor]}
function uniqueName(f,base){const names=new Set(plan().floors.flatMap(x=>x.rooms.map(r=>r.name)));if(!names.has(base))return base;let i=2;while(names.has(base+' '+i))i++;return base+' '+i}
function startPending(fi,rect){
  const f=plan().floors[fi],area=rectArea(f,rect),l=labelIn(f,rect),lt=l&&labelType(l.t),type=lt||(area&&area<4?'wc':area&&area<8?'flur':'wohnen');
  ED.pending={fi,rect,type,name:lt?uniqueName(f,nameFromLabel(l.t)):uniqueName(f,RT[type].n),windows:guessWindows(type,area)};render();
  setTimeout(()=>{const e=document.getElementById('pendForm');if(e)e.scrollIntoView({block:'nearest',behavior:'smooth'})},50);
}
document.addEventListener('pointerdown',e=>{
  const svg=e.target.closest&&e.target.closest('#plansvg'); if(!svg||ED.busy) return;
  const f=curFloor(),P=f.plan,pt=svgPt(svg,e),tool=ED.tool;
  if(P.scale&&!ED.edit) return;
  if(tool==='scale'){if(ED.scalePts.length<2)return;e.preventDefault();svg.setPointerCapture(e.pointerId);
    const pin=e.target.closest('[data-pin]');let i=pin?+pin.dataset.pin:null;
    // Tipp daneben: nächsten Pin dorthin holen
    if(i==null){const [a,b]=ED.scalePts;i=Math.hypot(a.x-pt.x,a.y-pt.y)<=Math.hypot(b.x-pt.x,b.y-pt.y)?0:1;ED.scalePts[i]=pt;movePinDom(i)}
    ED.drag={type:'pin',i};return}
  if(tool==='board'){P.board=pt;if(!plan().floors.some(x=>x.plan&&x.plan.main))P.main=true;ED.tool='move';changed();return}
  const itEl=e.target.closest('[data-item]');
  if(tool==='erase'){if(itEl){const [ri,ii]=itEl.dataset.item.split(':').map(Number);const r=f.rooms[ri];r.items.splice(ii,1);syncDev(r);changed()}return}
  if(tool==='move'){if(!itEl)return;e.preventDefault();svg.setPointerCapture(e.pointerId);const [ri,ii]=itEl.dataset.item.split(':').map(Number);ED.drag={type:'item',el:itEl,ri,ii,pt};return}
  if(tool==='add'){const r=roomAt(f,pt);if(!r){toast('Tippe in einen Raum');return}r.items=r.items||[];r.items.push({id:uid(),k:ED.addK,x:pt.x,y:pt.y});syncDev(r);changed();return}
  if(tool==='room'){e.preventDefault();svg.setPointerCapture(e.pointerId);ED.drag={type:'rect',start:pt,cur:pt}}
});
document.addEventListener('pointermove',e=>{
  const d=ED.drag;if(!d)return;const svg=document.getElementById('plansvg');if(!svg)return;const pt=svgPt(svg,e);
  if(d.type==='pin'){ED.scalePts[d.i]=pt;movePinDom(d.i);return}
  if(d.type==='item'){d.pt=pt;d.el.setAttribute('transform',`translate(${pt.x} ${pt.y})`)}
  else{d.cur=pt;const r=document.getElementById('dragrect'),x=Math.min(d.start.x,pt.x),y=Math.min(d.start.y,pt.y);
    r.setAttribute('x',x);r.setAttribute('y',y);r.setAttribute('width',Math.abs(pt.x-d.start.x));r.setAttribute('height',Math.abs(pt.y-d.start.y));r.setAttribute('visibility','visible')}
});
document.addEventListener('pointerup',async e=>{
  const d=ED.drag;if(!d)return;ED.drag=null;const f=curFloor();
  if(d.type==='pin')return;
  if(d.type==='item'){const it=f.rooms[d.ri].items[d.ii];it.x=d.pt.x;it.y=d.pt.y;changed();return}
  const s=symR(f),w=Math.abs(d.cur.x-d.start.x),h=Math.abs(d.cur.y-d.start.y);
  if(w>s*2&&h>s*2){startPending(S.floor,{x:Math.min(d.start.x,d.cur.x),y:Math.min(d.start.y,d.cur.y),w,h});return}
  ED.busy=true;document.body.classList.add('busy');
  try{const res=await detectRoom(f,d.start.x,d.start.y);if(res.error){toast(res.error);render()}else startPending(S.floor,res.rect)}
  catch(err){toast('Erkennung fehlgeschlagen: '+errText(err))}
  finally{ED.busy=false;document.body.classList.remove('busy')}
});
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;const d=b.dataset;
  if(d.tool){ED.tool=d.tool;render();return}
  if(!d.ed)return;const f=curFloor();
  switch(d.ed){
    case 'zoomin':ED.zoom=Math.min(4,ED.zoom*1.5);render();break;
    case 'zoomout':ED.zoom=Math.max(1,ED.zoom/1.5);render();break;
    case 'scalereset':ED.scalePts=[];ED.pinsFor=null;render();break;
    case 'rescale':f.plan.scale=null;ED.scalePts=[];ED.pinsFor=null;ED.tool='scale';ED.edit=false;changed();break;
    case 'edit':ED.edit=true;ED.tool='move';render();break;
    case 'editdone':ED.edit=false;ED.pending=null;render();break;
    case 'rmplan':if(confirm('Grundriss dieser Etage entfernen? Die Räume bleiben als Liste erhalten.')){delete f.plan;f.rooms.forEach(r=>{delete r.rect;delete r.items});changed()}break;
    case 'pendno':ED.pending=null;render();break;
    case 'autorooms':{const fl=curFloor();fl.rooms=fl.rooms.filter(r=>!r.rect);runAutoRooms();break}
    case 'labels':runLabels();break;
  }
});
document.addEventListener('change',e=>{
  if(e.target.id==='edAddK'){ED.addK=e.target.value;return}
  if(e.target.id==='pdType'&&ED.pending){const pd=ED.pending,f=plan().floors[pd.fi],old=pd.name;pd.type=e.target.value;
    if(Object.values(RT).some(v=>old.startsWith(v.n))) pd.name=uniqueName(f,RT[pd.type].n);
    pd.windows=guessWindows(pd.type,rectArea(f,pd.rect));render()}
});
document.addEventListener('submit',e=>{
  if(e.target.id==='scaleForm'){e.preventDefault();e.stopImmediatePropagation();
    const m=parseFloat(String(document.getElementById('scaleM').value).replace(',','.'));if(!(m>0))return;
    const [a,b]=ED.scalePts,f=curFloor(),d=Math.hypot(a.x-b.x,a.y-b.y);if(d<5){toast('Die Pins liegen aufeinander. Ziehe sie an die Enden der Strecke.');return}
    f.plan.scale=d/m;ED.scalePts=[];ED.pinsFor=null;ED.scaleM='';
    f.rooms.forEach(r=>{if(r.rect)r.area=rectArea(f,r.rect)});ED.tool='room';ED.edit=false;if(!f.rooms.some(r=>r.rect))runAutoRooms();else changed();return}
  if(e.target.id==='pendForm'){e.preventDefault();e.stopImmediatePropagation();
    const pd=ED.pending,p=plan(),f=p.floors[pd.fi];
    const r={id:uid(),name:document.getElementById('pdName').value.trim()||RT[pd.type].n,type:document.getElementById('pdType').value,
      area:rectArea(f,pd.rect)||16,windows:Math.max(0,parseInt(document.getElementById('pdWin').value)||0),rect:pd.rect,dev:{}};
    r.dev=rec(r,p.aw);autoPlace(f,r);syncDev(r);f.rooms.push(r);ED.pending=null;ED.sel=r.id;changed();toast(`${r.name}: ${r.items.length} Anschlüsse vorgeschlagen`)}
},true);

/* ---------- Beispiel-Grundriss (Erdgeschoss Musterhaus), 60 px = 1 m */
function exampleFloor(){
  const S_=60,M=40,W=10,H=8.5,c=document.createElement('canvas');c.width=W*S_+2*M;c.height=H*S_+2*M+30;
  const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.fillStyle='#222';
  const X=v=>M+v*S_,Y=v=>M+v*S_,wall=(x0,y0,x1,y1,t)=>{g.fillRect(Math.min(X(x0),X(x1))-t/2,Math.min(Y(y0),Y(y1))-t/2,Math.abs(X(x1)-X(x0))+t,Math.abs(Y(y1)-Y(y0))+t)};
  const T=16,t=8;
  wall(0,0,10,0,T);wall(0,8.5,10,8.5,T);wall(0,0,0,8.5,T);wall(10,0,10,8.5,T);
  wall(6,0,6,8.5,t);wall(6,3.5,10,3.5,t);wall(0,5.3,6,5.3,t);wall(3,5.3,3,8.5,t);wall(4.2,5.3,4.2,8.5,t);
  g.fillStyle='#fff';const door=(x0,y0,x1,y1)=>g.fillRect(X(x0)-(x0===x1?10:0),Y(y0)-(y0===y1?10:0),X(x1)-X(x0)+(x0===x1?20:0),Y(y1)-Y(y0)+(y0===y1?20:0));
  door(6,1.2,6,2.0);door(7.5,3.5,8.3,3.5);door(6,5.5,6,6.3);door(1,5.3,1.8,5.3);door(3,6,3,6.8);door(4.2,6.5,4.2,7.3);door(1.2,8.5,2.0,8.5);
  g.fillStyle='#444';g.font='16px sans-serif';
  [['Wohnen',2.2,2.6],['Essen',7.3,1.8],['Küche',7.3,6],['Flur',1,7],['WC',3.25,7.8],['HWR',4.7,7]].forEach(([s,x,y])=>g.fillText(s,X(x),Y(y)));
  g.strokeStyle='#444';g.beginPath();g.moveTo(X(0),Y(H)+24);g.lineTo(X(W),Y(H)+24);g.stroke();g.fillText('10,00 m',X(4.5),Y(H)+20);
  return {img:c.toDataURL('image/jpeg',0.85),w:c.width,h:c.height,scale:S_,board:{x:X(5.2),y:Y(8.1)},main:true,
    rects:Object.fromEntries(Object.entries({Wohnzimmer:[0,0,6,5.3],Esszimmer:[6,0,10,3.5],'Küche':[6,3.5,10,8.5],Flur:[0,5.3,3,8.5],WC:[3,5.3,4.2,8.5],Hauswirtschaft:[4.2,5.3,6,8.5]}).map(([k,[a,b,c2,d]])=>[k,{x:X(a)+4,y:Y(b)+4,w:(c2-a)*S_-8,h:(d-b)*S_-8}]))};
}
function withExampleFloor(p){
  try{
    const ex=exampleFloor(),f=p.floors[0];
    f.plan={img:ex.img,w:ex.w,h:ex.h,scale:ex.scale,board:ex.board,main:true};
    f.rooms.forEach(r=>{const R=ex.rects[r.name];if(R){r.rect=R;r.area=rectArea(f,R);r.dev=rec(r,p.aw);autoPlace(f,r);syncDev(r)}});
  }catch(e){}
  return p;
}
document.addEventListener('input',e=>{if(e.target.id==='scaleM')ED.scaleM=e.target.value});
