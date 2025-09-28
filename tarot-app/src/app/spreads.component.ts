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
  delay: number;        // ms para stagger
  dealt: boolean;
  faceup: boolean;
  layer: number;        // capa a la que pertenece
};

type Slot = { position:number; x:number; y:number; r:number; z:number };

type Layer = {
  id: number;
  cards: Placed[];
};

type FreeLayout = 'pile' | 'grid' | 'fan';

@Component({
  selector: 'app-spreads',
  standalone: true,
  imports: [CommonModule, FormsModule, DragDropModule],
  templateUrl: './spreads.component.html',
  styleUrls: ['./spreads.component.scss'],
})
export class SpreadsComponent implements OnInit {
  private api = inject(TarotApi);
  private loader = inject(ImageLoaderService);
  private zone = inject(NgZone);
  private cdr  = inject(ChangeDetectorRef);

  // === estado principal ===
  spreadId: 'celtic-cross-10' | 'ppf-3' | 'free' = 'celtic-cross-10';
  spreadLabel = 'Cruz Celta';

  backUrl!: string;               // SOLO contracara
  boardBgUrl: string = ''; 

  constructor() {
  // CARD_BACK_URL explícita > API_BASE + /cdn/... > ruta relativa
  this.backUrl =
    (environment.CARD_BACK_URL ||
      (environment.API_BASE ? `${environment.API_BASE}/cdn/cards/contracara.png` : '/cdn/cards/contracara.png'));
}

  deckMap = new Map<string, CardMeta>();
  spreads: SpreadDef[] = [];

  slots: Slot[] = [];     // guía para layouts cerrados
  placed: Placed[] = [];  // compat legado (se usa cuando no hay capas)
  layers: Layer[] = [{ id: 1, cards: [] }]; // capas para Libre
  activeLayer = 0;        // índice (0..)
  layerOverlay = false;   // animación al crear nueva capa

  // UI
  loadingDeck = true;
  deckReady   = false;
  deckError: string | null = null;
  deckCount   = 0;
  dealing     = false;

  // Libre
  freeLayout: FreeLayout = 'pile';
  private focusIdx = 0;

  get canDeal() { return this.deckReady && !this.dealing; }
  get isFree()  { return this.spreadId === 'free'; }
  get activeCards(): Placed[] {
    return this.isFree ? this.layers[this.activeLayer]?.cards ?? [] : this.placed;
  }

  private bgCandidates = [
    `${environment.API_BASE}/cdn/cards/celtic-cloth.png`,
    `${environment.API_BASE}/cdn/cards/celtic-cloth.jpg`,
  ];

  async ngOnInit() {
    this.resolveBgInBackground();
    await this.loadDeckFirst();
    this.rebuildSlots();
    this.loadSpreadsInBackground();
  }

  private resolveBgInBackground() {
    for (const url of this.bgCandidates) {
      const img = new Image();
      img.onload = () => { if (!this.boardBgUrl) this.boardBgUrl = url; };
      img.onerror = () => {};
      img.src = url;
    }
  }

  async loadDeckFirst() {
    this.loadingDeck = true; this.deckError = null;
    try {
      const deck = await firstValueFrom(this.api.decks());
      this.zone.run(() => {
        this.deckMap.clear();
        deck.forEach((c) => this.deckMap.set(c.id, c));
        this.deckCount = deck.length;
        this.deckReady = true;
        this.loadingDeck = false;
        this.cdr.markForCheck();
      });
      // precarga contracara sin bloquear
      this.loader.preloadAll([this.backUrl], 12000, { ignoreErrors: true }).catch(()=>{});
    } catch (e: any) {
      this.zone.run(() => {
        this.deckError = e?.message ?? 'No se pudo cargar el mazo';
        this.deckReady = false; this.deckCount = 0; this.loadingDeck = false;
        this.cdr.markForCheck();
      });
    }
  }

  private loadSpreadsInBackground() {
    this.api.spreads().subscribe({
      next: (sps) => (this.spreads = sps),
      error: () => {},
    });
  }

  onSpreadChange() {
    this.spreadLabel =
      this.spreadId === 'celtic-cross-10' ? 'Cruz Celta' :
      this.spreadId === 'ppf-3' ? 'Pasado · Presente · Futuro' : 'Libre';
    this.rebuildSlots();
    this.placed = [];
    if (this.isFree) {
      this.layers = [{ id: 1, cards: [] }];
      this.activeLayer = 0;
    }
  }

  private rebuildSlots() {
    const layout = this.buildLayout(this.spreadId);
    this.slots = layout.map(p => ({ ...p }));
  }

  getFrontUrl(cardId: string | undefined) {
    return cardId ? this.deckMap.get(cardId)?.imageUrl : undefined;
  }

  // =========================
  // Tiradas "cerradas"
  // =========================
  async hacerTirada() {
    if (!this.canDeal) return;

    if (this.isFree) {
      // en Libre, hacerTirada añade 10 por defecto
      this.agregarCartaLibre(10);
      return;
    }

    this.dealing = true;

    const res: DrawResult = await firstValueFrom(this.api.draw(this.spreadId));
    const withPos: Placed[] = res.cards.map((c, i) => {
      const p = this.slots[i] || { x: 50, y: 50, r: 0, z: 10 + i, position: i + 1 };
      return {
        position: p.position, cardId: c.cardId, reversed: c.reversed,
        x: p.x, y: p.y, r: p.r, z: p.z,
        delay: i * 80, dealt: false, faceup: false, layer: 0,
      };
    });

    // precarga tolerante
    try {
  const fronts = withPos.map(pc => this.getFrontUrl(pc.cardId)).filter(Boolean) as string[];
  this.loader
    .preloadAll([this.backUrl, ...fronts], 60000, { ignoreErrors: true })
    .then(({ fail }) => { if (fail.length) console.warn('[preload] fallaron', fail.length); })
    .catch(() => {});
} catch {}
    this.placed = withPos;

    // animación de reparto + flip
    setTimeout(() => {
      this.placed.forEach((pc, i) => {
        setTimeout(() => {
          pc.dealt = true;
          setTimeout(() => (pc.faceup = true), 350);
        }, i * 120);
      });
      const totalMs = this.placed.length * 120 + 450;
      setTimeout(() => (this.dealing = false), totalMs);
    });
  }

  // =========================
  // Libre: ilimitado + capas + layouts + drag
  // =========================
  agregarCartaLibre(n = 1) {
    if (!this.deckReady) return;

    // conjunto usado en todas las capas
    const used = new Set<string>(this.layers.flatMap(l => l.cards.map(c => c.cardId)));

    const allIds = Array.from(this.deckMap.keys());
    const candidates = allIds.filter(id => !used.has(id));
    if (!candidates.length) return;

    const target = this.layers[this.activeLayer];
    if (!target) return;

    // si supera 10, crear nueva capa con overlay animado
    const room = Math.max(0, 10 - target.cards.length);
    let toCurrent = Math.min(room, n);
    let remaining = n - toCurrent;

    if (toCurrent > 0) {
      const cards = this.generateFreeCards(candidates, toCurrent, this.activeLayer);
      target.cards.push(...cards);
      this.runDealAnimation(cards);
    }

    while (remaining > 0) {
      this.createNextLayer();
      const next = this.layers[this.activeLayer];
      const cards = this.generateFreeCards(
        allIds.filter(id => !this.layers.flatMap(l => l.cards).some(c => c.cardId === id)),
        Math.min(10, remaining),
        this.activeLayer
      );
      next.cards.push(...cards);
      this.runDealAnimation(cards);
      remaining -= cards.length;
    }
  }

  private generateFreeCards(pool: string[], count: number, layerIndex: number): Placed[] {
    const out: Placed[] = [];
    for (let i = 0; i < count && pool.length; i++) {
      const pickIdx = Math.floor(Math.random() * pool.length);
      const cardId = pool.splice(pickIdx, 1)[0];
      const reversed = Math.random() < 0.5;

      const p = this.layoutFreePosition(this.freeLayout, i);
      out.push({
        position: p.position,
        cardId, reversed,
        x: p.x, y: p.y, r: p.r, z: 20 + i,
        delay: i * 60, dealt: false, faceup: false, layer: layerIndex,
      });
    }
   const urls = out.map(c => this.getFrontUrl(c.cardId)).filter(Boolean) as string[];
    this.loader.preloadAll([this.backUrl, ...urls], 60000, { ignoreErrors: true })
  .then(() => {})
  .catch(() => {});
return out; // precarga sin bloquear
   
   
  }

  private createNextLayer() {
    const id = this.layers.length + 1;
    this.layers.push({ id, cards: [] });
    this.activeLayer = this.layers.length - 1;
    // overlay animado
    this.layerOverlay = true;
    setTimeout(() => (this.layerOverlay = false), 500);
  }

  switchLayer(idx: number) {
    if (idx < 0 || idx >= this.layers.length) return;
    this.activeLayer = idx;
  }

  // layouts para libre
  private layoutFreePosition(kind: FreeLayout, i: number): { position:number; x:number; y:number; r:number } {
    if (kind === 'grid') {
      const cols = 5; const gapX = 12; const gapY = 16;
      const row = Math.floor(i / cols); const col = i % cols;
      const x = 30 + col * gapX; const y = 30 + row * gapY;
      return { position: i + 1, x: Math.min(85, x), y: Math.min(80, y), r: 0 };
    }
    if (kind === 'fan') {
      const centerX = 50, centerY = 58;
      const baseR = -15; const stepR = 6;
      const r = baseR + i * stepR;
      const radius = 16;
      const rad = (r * Math.PI) / 180;
      const x = centerX + radius * Math.sin(rad);
      const y = centerY - radius * Math.cos(rad);
      return { position: i + 1, x, y, r };
    }
    // pile
    const rand = (a:number,b:number)=> a + Math.random()*(b-a);
    return { position: i + 1, x: 50 + rand(-6, 6), y: 52 + rand(-6, 6), r: rand(-8, 8) };
  }

  private runDealAnimation(cards: Placed[]) {
    setTimeout(() => {
      cards.forEach((pc, i) => {
        setTimeout(() => {
          pc.dealt = true;
          setTimeout(() => (pc.faceup = true), 300);
        }, i * 100);
      });
    });
  }

  // Drag & Drop: guarda posiciones relativas (%) al soltar
  onDragEnd(pc: Placed, ev: CdkDragEnd) {
    const el = ev.source.getRootElement() as HTMLElement;
    const board = el.closest('.board') as HTMLElement;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const cx = el.getBoundingClientRect().left + el.offsetWidth/2;
    const cy = el.getBoundingClientRect().top  + el.offsetHeight/2;
    pc.x = ((cx - rect.left) / rect.width) * 100;
    pc.y = ((cy - rect.top)  / rect.height) * 100;
    // persistir en localStorage (por carta+layer)
    try {
      const key = `free-pos-v1-${pc.layer}`;
      const map = JSON.parse(localStorage.getItem(key) || '{}');
      map[pc.cardId] = { x: pc.x, y: pc.y, r: pc.r };
      localStorage.setItem(key, JSON.stringify(map));
    } catch {}
  }

  // flip + bring to front
  onCardClick(pc: Placed, ev: MouseEvent) {
    ev.stopPropagation();
    pc.faceup = !pc.faceup;
    const maxZ = Math.max(...this.activeCards.map(p => p.z));
    pc.z = maxZ + 1;
  }

  // navegación (opcional, botones en panel)
  prevCard() {
    const arr = this.activeCards;
    if (!arr.length) return;
    this.focusIdx = (this.focusIdx - 1 + arr.length) % arr.length;
    this.bumpZ(arr, this.focusIdx);
  }
  nextCard() {
    const arr = this.activeCards;
    if (!arr.length) return;
    this.focusIdx = (this.focusIdx + 1) % arr.length;
    this.bumpZ(arr, this.focusIdx);
  }
  private bumpZ(arr: Placed[], i: number) {
    const maxZ = Math.max(...arr.map(p=>p.z));
    arr[i].z = maxZ + 1;
  }

  /* === layouts "cerrados" existentes === */
  private buildLayout(id: string): Array<{ position:number; x:number; y:number; r:number; z:number }> {
    if (id === 'celtic-cross-10') return this.celticCross10();
    if (id === 'ppf-3')          return this.ppf3();
    return this.free9();
  }

  private celticCross10() {
    const Cx = 45, Cy = 52, dx = 15, dy = 15, colX = 80, h = 15;
    return [
      { position:1, x:Cx,     y:Cy,     r:0,   z:20 },
      { position:2, x:Cx,     y:Cy,     r:90,  z:21 },
      { position:3, x:Cx,     y:Cy+dy,  r:0,   z:19 },
      { position:4, x:Cx-dx,  y:Cy,     r:0,   z:19 },
      { position:5, x:Cx,     y:Cy-dy,  r:0,   z:19 },
      { position:6, x:Cx+dx,  y:Cy,     r:0,   z:19 },
      { position:7, x:colX,   y:Cy+h*2, r:0,   z:18 },
      { position:8, x:colX,   y:Cy+h,   r:0,   z:18 },
      { position:9, x:colX,   y:Cy,     r:0,   z:18 },
      { position:10,x:colX,   y:Cy-h,   r:0,   z:18 },
    ];
  }

  private ppf3() {
    return [
      { position:1, x:35, y:52, r:0, z:10 },
      { position:2, x:50, y:52, r:0, z:11 },
      { position:3, x:65, y:52, r:0, z:12 },
    ];
  }

  private free9() {
    const baseX = 50, baseY = 52;
    const rand = (a:number,b:number)=> a + Math.random()*(b-a);
    return Array.from({length:9},(_,i)=>({
      position: i+1,
      x: baseX + rand(-6, 6),
      y: baseY + rand(-6, 6),
      r: rand(-8, 8),
      z: 20 + i
    }));
  }
}
