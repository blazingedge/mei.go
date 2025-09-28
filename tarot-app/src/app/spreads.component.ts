import { Component, OnInit, inject, NgZone, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DragDropModule, CdkDragEnd } from '@angular/cdk/drag-drop';
import { firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';
import { TarotApi, CardMeta, SpreadDef, DrawResult } from '../services/spreads.service';
import { ImageLoaderService } from '../services/image-loader.service';

type Placed = {
  position: number;
  cardId: string;
  reversed: boolean;
  x: number; y: number; r: number; z: number;
  delay: number; dealt: boolean; faceup: boolean;
  layer: number;
};
type Slot  = { position:number; x:number; y:number; r:number; z:number };
type Layer = { id:number; cards:Placed[] };
type FreeLayout = 'pile'|'grid'|'fan';

type HistoryEntry = {
  id: string;
  spreadId: 'celtic-cross-10'|'ppf-3'|'free';
  spreadLabel: string;
  cards: Placed[];
  ts?: number | null;     // ← se agrega sólo al abrir historial
};

const HISTORY_KEY = 'tarot-history-v1';

@Component({
  selector: 'app-spreads',
  standalone: true,
  imports: [CommonModule, FormsModule, DragDropModule],
  templateUrl: './spreads.component.html',
  styleUrls: ['./spreads.component.scss'],
})
export class SpreadsComponent implements OnInit {
  private api   = inject(TarotApi);
  private loader= inject(ImageLoaderService);
  private zone  = inject(NgZone);
  private cdr   = inject(ChangeDetectorRef);

  // ===== estado principal =====
  spreadId: 'celtic-cross-10'|'ppf-3'|'free' = 'celtic-cross-10';
  spreadLabel = 'Cruz Celta';

  backUrl!: string;                 // SOLO contracara
  boardBgUrl = '';

  deckMap = new Map<string, CardMeta>();
  spreads: SpreadDef[] = [];

  slots:  Slot[] = [];
  placed: Placed[] = [];
  layers: Layer[] = [{ id:1, cards:[] }];
  activeLayer = 0;
  layerOverlay = false;

  // UI
  loadingDeck = true; deckReady=false; deckError:string|null=null;
  deckCount=0; dealing=false; deckProgress=0; deckShuffling=false;

  // Cruz Celta
  stepMode = false;
  private buffer: Placed[] = [];
  private nextIdx = 0;

  // Libre
  freeLayout: FreeLayout = 'pile';
  private focusIdx = 0;

  // Historial
  showHistory = false;
  historyList: HistoryEntry[] = [];

  get canDeal(){ return this.deckReady && !this.dealing; }
  get isFree(){ return this.spreadId === 'free'; }
  get activeCards():Placed[]{ return this.isFree ? (this.layers[this.activeLayer]?.cards ?? []) : this.placed; }

  private bgCandidates = [
    `${environment.API_BASE}/cdn/cards/celtic-cloth.webp`,
    `${environment.API_BASE}/cdn/cards/celtic-cloth.jpg`,
  ];

  constructor(){
    // CARD_BACK_URL > API_BASE > fallback relativo
    this.backUrl =
      environment.CARD_BACK_URL ||
      (environment.API_BASE ? `${environment.API_BASE}/cdn/cards/contracara.webp` : '/cdn/cards/contracara.webp');
  }

  async ngOnInit(){
    this.resolveBgInBackground();
    await this.loadDeckFirst();
    this.rebuildSlots();
    this.loadSpreadsInBackground();
  }

  private resolveBgInBackground(){
    for(const url of this.bgCandidates){
      const img = new Image();
      img.onload = () => { if(!this.boardBgUrl) this.boardBgUrl = url; };
      img.src = url;
    }
  }

  async loadDeckFirst(){
    this.loadingDeck = true; this.deckError = null;
    try{
      const deck = await firstValueFrom(this.api.decks());
      this.zone.run(()=>{
        this.deckMap.clear();
        deck.forEach(c => this.deckMap.set(c.id,c));
        this.deckCount = deck.length;
        this.deckReady = true;
        this.loadingDeck = false;
        this.cdr.markForCheck();
      });
      this.loader.preloadAll([this.backUrl], 12000, {ignoreErrors:true}).catch(()=>{});
      this.bumpDeckProgress(100, 900);
    }catch(e:any){
      this.zone.run(()=>{
        this.deckError = e?.message ?? 'No se pudo cargar el mazo';
        this.deckReady=false; this.deckCount=0; this.loadingDeck=false; this.cdr.markForCheck();
      });
    }
  }

  private loadSpreadsInBackground(){
    this.api.spreads().subscribe({ next:s => this.spreads=s, error:()=>{} });
  }

  onSpreadChange(){
    this.spreadLabel =
      this.spreadId==='celtic-cross-10' ? 'Cruz Celta' :
      this.spreadId==='ppf-3'           ? 'Pasado · Presente · Futuro' : 'Libre';
    this.rebuildSlots();
    this.placed = [];
    if (this.isFree){
      this.layers = [{id:1,cards:[]}];
      this.activeLayer = 0;
    }
  }

  private rebuildSlots(){
    const layout = this.buildLayout(this.spreadId);
    this.slots = layout.map(p => ({...p}));
  }

  getFrontUrl(cardId?:string){ return cardId ? this.deckMap.get(cardId)?.imageUrl : undefined; }

  // ---------- UI helpers ----------
  toggleShuffle(){ this.deckShuffling = !this.deckShuffling; if(this.deckShuffling) setTimeout(()=>this.deckShuffling=false, 1600); }
  private bumpDeckProgress(target=100,ms=800){
    const start=this.deckProgress, steps=20, inc=(target-start)/steps, dt=Math.max(12,ms/steps);
    let i=0; const t=setInterval(()=>{ this.deckProgress = Math.min(100, Math.round(start+inc*++i)); if(i>=steps) clearInterval(t); }, dt);
  }

  // ---------- Tiradas ----------
  async hacerTirada(){
    if(!this.canDeal) return;

    if(this.isFree){ this.agregarCartaLibre(10); return; }

    this.dealing = true;
    const res: DrawResult = await firstValueFrom(this.api.draw(this.spreadId));
    const withPos: Placed[] = res.cards.map((c,i)=>{
      const p = this.slots[i] || {x:50,y:50,r:0,z:10+i,position:i+1};
      return { position:p.position, cardId:c.cardId, reversed:c.reversed, x:p.x,y:p.y,r:p.r,z:p.z, delay:i*80, dealt:false, faceup:false, layer:0 };
    });

    try{
      const fronts = withPos.map(pc=>this.getFrontUrl(pc.cardId)).filter(Boolean) as string[];
      this.loader.preloadAll([this.backUrl, ...fronts], 60000, {ignoreErrors:true}).catch(()=>{});
    }catch{}

    this.placed = withPos;

    setTimeout(()=>{
      this.placed.forEach((pc,i)=>{
        setTimeout(()=>{ pc.dealt=true; setTimeout(()=>pc.faceup=true, 350); }, i*120);
      });
      const totalMs = this.placed.length*120 + 450;
      setTimeout(()=>{ this.dealing=false; this.saveToHistory(); }, totalMs);
    });
  }

  // Libre
  agregarCartaLibre(n=1){
    if(!this.deckReady) return;

    const used = new Set<string>(this.layers.flatMap(l => l.cards.map(c => c.cardId)));
    const allIds = Array.from(this.deckMap.keys());
    const pool = allIds.filter(id => !used.has(id));
    if(!pool.length) return;

    const target = this.layers[this.activeLayer]; if(!target) return;
    const room = Math.max(0, 10 - target.cards.length);
    let toCurrent = Math.min(room, n); let remaining = n - toCurrent;

    if(toCurrent>0){
      const cards = this.generateFreeCards(pool, toCurrent, this.activeLayer);
      target.cards.push(...cards); this.runDealAnimation(cards);
    }

    while(remaining>0){
      this.createNextLayer();
      const fresh = allIds.filter(id => !this.layers.flatMap(l=>l.cards).some(c=>c.cardId===id));
      const cards = this.generateFreeCards(fresh, Math.min(10,remaining), this.activeLayer);
      this.layers[this.activeLayer].cards.push(...cards); this.runDealAnimation(cards);
      remaining -= cards.length;
    }
  }

  private generateFreeCards(pool:string[], count:number, layerIndex:number):Placed[]{
    const out:Placed[]=[];
    for(let i=0; i<count && pool.length; i++){
      const idx=Math.floor(Math.random()*pool.length);
      const cardId = pool.splice(idx,1)[0];
      const reversed = Math.random()<0.5;
      const p=this.layoutFreePosition(this.freeLayout,i);
      out.push({ position:p.position, cardId, reversed, x:p.x,y:p.y,r:p.r,z:20+i, delay:i*60,dealt:false,faceup:false,layer:layerIndex });
    }
    const urls = out.map(c=>this.getFrontUrl(c.cardId)).filter(Boolean) as string[];
    this.loader.preloadAll([this.backUrl, ...urls], 60000, {ignoreErrors:true}).catch(()=>{});
    return out;
  }

  private createNextLayer(){
    const id=this.layers.length+1;
    this.layers.push({id,cards:[]}); this.activeLayer=this.layers.length-1;
    this.layerOverlay=true; setTimeout(()=>this.layerOverlay=false, 500);
  }

  switchLayer(i:number){ if(i>=0 && i<this.layers.length) this.activeLayer=i; }

  private layoutFreePosition(kind:FreeLayout, i:number){
    if(kind==='grid'){ const cols=5,gx=12,gy=16,row=Math.floor(i/cols),col=i%cols, x=30+col*gx,y=30+row*gy; return {position:i+1,x:Math.min(85,x),y:Math.min(80,y),r:0}; }
    if(kind==='fan'){ const cx=50,cy=58, base=-15, step=6, r=base+i*step, rad=r*Math.PI/180, R=16, x=cx+R*Math.sin(rad), y=cy-R*Math.cos(rad); return {position:i+1,x,y,r}; }
    const rand=(a:number,b:number)=>a+Math.random()*(b-a); return {position:i+1,x:50+rand(-6,6),y:52+rand(-6,6),r:rand(-8,8)};
  }

  private runDealAnimation(cards:Placed[]){
    setTimeout(()=>{ cards.forEach((pc,i)=>{ setTimeout(()=>{ pc.dealt=true; setTimeout(()=>pc.faceup=true,300); }, i*100); }); this.saveToHistory(); });
  }

  // Drag
  onDragEnd(pc:Placed, ev:CdkDragEnd){
    const el = ev.source.getRootElement() as HTMLElement;
    const board = el.closest('.board') as HTMLElement; if(!board) return;
    const rect=board.getBoundingClientRect(), cx=el.getBoundingClientRect().left+el.offsetWidth/2, cy=el.getBoundingClientRect().top+el.offsetHeight/2;
    pc.x=((cx-rect.left)/rect.width)*100; pc.y=((cy-rect.top)/rect.height)*100;
  }

  onCardClick(pc:Placed, ev:MouseEvent){ ev.stopPropagation(); pc.faceup=!pc.faceup; const maxZ=Math.max(...this.activeCards.map(p=>p.z)); pc.z=maxZ+1; }

  prevCard(){ const arr=this.activeCards; if(!arr.length) return; this.focusIdx=(this.focusIdx-1+arr.length)%arr.length; this.bumpZ(arr,this.focusIdx); }
  nextCard(){ const arr=this.activeCards; if(!arr.length) return; this.focusIdx=(this.focusIdx+1)%arr.length; this.bumpZ(arr,this.focusIdx); }
  private bumpZ(arr:Placed[], i:number){ const maxZ=Math.max(...arr.map(p=>p.z)); arr[i].z=maxZ+1; }

  // Mazo: decide acción
  onDeckClick(){
    if(!this.canDeal){ this.toggleShuffle(); return; }

    if(this.spreadId==='celtic-cross-10'){
      if(this.stepMode){
        if(!this.buffer.length || this.nextIdx===0){ this.prepararCruzPasoAPaso().then(()=>this.colocarSiguientePosicion()); }
        else { this.colocarSiguientePosicion(); }
      } else {
        this.repartirCruzCompleta();
      }
      return;
    }

    if(this.isFree){ this.agregarCartaLibre(1); return; }

    this.hacerTirada(); // PPF
  }

  // Cruz completa
  async repartirCruzCompleta(){
    if(!this.canDeal) return;
    this.stepMode=false; this.spreadId='celtic-cross-10'; this.onSpreadChange();
    await this.hacerTirada();
  }

  // Cruz paso a paso
  async prepararCruzPasoAPaso(){
    if(!this.deckReady) return;
    this.stepMode=true; this.spreadId='celtic-cross-10'; this.onSpreadChange(); this.dealing=true;

    const res:DrawResult = await firstValueFrom(this.api.draw('celtic-cross-10'));
    const mapped:Placed[] = res.cards.map((c,i)=>{ const p=this.slots[i]||{x:50,y:50,r:0,z:10+i,position:i+1};
      return {position:p.position, cardId:c.cardId, reversed:c.reversed, x:p.x,y:p.y,r:p.r,z:p.z, delay:0,dealt:false,faceup:false,layer:0}; });

    try{
      const fronts=mapped.map(m=>this.getFrontUrl(m.cardId)).filter(Boolean) as string[];
      this.loader.preloadAll([this.backUrl, ...fronts], 60000, {ignoreErrors:true}).catch(()=>{});
    }catch{}

    this.placed=[]; this.buffer=mapped; this.nextIdx=0; this.dealing=false;
  }

  colocarSiguientePosicion(){
    if(!this.stepMode || this.nextIdx>=this.buffer.length) return;
    const pc=this.buffer[this.nextIdx++]; this.placed.push(pc);
    setTimeout(()=>{ pc.dealt=true; setTimeout(()=>pc.faceup=true,350); if(this.nextIdx>=this.buffer.length) this.saveToHistory(); });
  }

  // ---------- Layouts cerrados ----------
  private buildLayout(id:string){
    if(id==='celtic-cross-10') return this.celticCross10();
    if(id==='ppf-3')          return this.ppf3();
    return this.free9();
  }

  private celticCross10(){
    const Cx=45,Cy=52,dx=15,dy=15,colX=80,h=15;
    return [
      {position:1,x:Cx,    y:Cy,    r:0,  z:20},
      {position:2,x:Cx,    y:Cy,    r:90, z:21},
      {position:3,x:Cx,    y:Cy+dy, r:0,  z:19},
      {position:4,x:Cx-dx, y:Cy,    r:0,  z:19},
      {position:5,x:Cx,    y:Cy-dy, r:0,  z:19},
      {position:6,x:Cx+dx, y:Cy,    r:0,  z:19},
      {position:7,x:colX,  y:Cy+h*2,r:0,  z:18},
      {position:8,x:colX,  y:Cy+h,  r:0,  z:18},
      {position:9,x:colX,  y:Cy,    r:0,  z:18},
      {position:10,x:colX, y:Cy-h,  r:0,  z:18},
    ];
  }
  private ppf3(){ return [{position:1,x:35,y:52,r:0,z:10},{position:2,x:50,y:52,r:0,z:11},{position:3,x:65,y:52,r:0,z:12}]; }
  private free9(){ const baseX=50,baseY=52,rand=(a:number,b:number)=>a+Math.random()*(b-a);
    return Array.from({length:9},(_,i)=>({position:i+1,x:baseX+rand(-6,6),y:baseY+rand(-6,6),r:rand(-8,8),z:20+i})); }

  // ---------- Historial ----------
  saveToHistory(){
    // guarda el estado actual (sin fecha)
    const cards = this.isFree ? this.layers[this.activeLayer].cards : this.placed;
    if(!cards.length) return;

    const entry:HistoryEntry = {
      id: crypto?.randomUUID?.() ?? String(Date.now()),
      spreadId: this.spreadId,
      spreadLabel: this.spreadLabel,
      cards: JSON.parse(JSON.stringify(cards)),
      ts: null, // ← se rellenará al abrir historial
    };

    const list = this.readHistory();
    list.unshift(entry);
    this.writeHistory(list);
  }

  openHistory(){
    let list=this.readHistory();
    let changed=false;
    list = list.map(e=>{ if(e.ts==null){ e.ts=Date.now(); changed=true; } return e; });
    if(changed) this.writeHistory(list);
    this.historyList = list;
    this.showHistory = true;
  }

  closeHistory(){ this.showHistory=false; }
  deleteHistory(id:string){ const list=this.readHistory().filter(e=>e.id!==id); this.writeHistory(list); this.historyList=list; }
  loadHistory(h:HistoryEntry){
    this.showHistory=false;
    this.spreadId=h.spreadId; this.spreadLabel=h.spreadLabel; this.onSpreadChange();
    if(h.spreadId==='free'){
      this.layers=[{id:1,cards: JSON.parse(JSON.stringify(h.cards))}]; this.activeLayer=0;
    } else {
      this.placed = JSON.parse(JSON.stringify(h.cards));
    }
  }
  formatTs(ts:number){ try{ return new Date(ts).toLocaleString(); } catch{ return String(ts); } }

  private readHistory():HistoryEntry[]{ try{ return JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]'); }catch{ return []; } }
  private writeHistory(list:HistoryEntry[]){ try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); }catch{} }
}
