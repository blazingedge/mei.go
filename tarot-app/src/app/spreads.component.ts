import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  NgZone,
  ChangeDetectorRef,
  DestroyRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DragDropModule, CdkDragEnd } from '@angular/cdk/drag-drop';
import { BreakpointObserver } from '@angular/cdk/layout';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { environment } from '../environments/environment';
import {
  TarotApi,
  CardMeta,
  SpreadDef,
  DrawResult,
  DrawCard,
} from '../services/spreads.service';
import { ImageLoaderService } from '../services/image-loader.service';
import { Auth } from '@angular/fire/auth';
import { NewlineToBrPipe } from './pipes/new-line-to-br-pipe';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HangingMenuComponent } from './components/hanging-menu.component';
import { AuthService } from './core/auth/auth.service';
import { SessionService } from './core/services/session.service';
import { Router } from '@angular/router';

type Placed = {
  position: number;
  cardId: string;
  reversed: boolean;
  x: number;
  y: number;
  r: number;
  z: number;
  delay: number;
  dealt: boolean;
  faceup: boolean;
  layer: number;
};
type Slot = { position: number; x: number; y: number; r: number; z: number };
type Layer = { id: number; cards: Placed[] };
type FreeLayout = 'pile' | 'grid' | 'fan';

type HistoryEntry = {
  id: string;
  spreadId: 'celtic-cross-10' | 'ppf-3' | 'free';
  spreadLabel: string;
  cards: Placed[];
  ts?: number | null;
};

type SavedReadingSummary = {
  id: string;
  title: string;
  createdAt: number;
};

type SavedReadingDetail = SavedReadingSummary & {
  interpretation: string;
  cards: { id: string; reversed: boolean; pos?: number }[];
  spreadId?: string;
};

const PLAN_LIMITS = {
  luz: { monthly: 1 },
  sabiduria: { monthly: 30 },
  quantico: { monthly: 9999 },
} as const;

const HISTORY_KEY = 'tarot-history-v1';

@Component({
  selector: 'app-spreads',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DragDropModule,
    HangingMenuComponent,
    NewlineToBrPipe,
  ],
  templateUrl: './spreads.component.html',
  styleUrls: ['./spreads.component.scss', './mobile.scss'],
})
export class SpreadsComponent implements OnInit, OnDestroy {
  private api = inject(TarotApi);
  private loader = inject(ImageLoaderService);
  private zone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);
  private auth = inject(Auth);
  private breakpointObserver = inject(BreakpointObserver);
  private authService = inject(AuthService);
  private sessionService = inject(SessionService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);

  // ===== estado principal =====
  spreadId: 'celtic-cross-10' | 'ppf-3' | 'free' = 'celtic-cross-10';
  spreadLabel = 'Cruz Celta';
  isMobile = false;
  private readonly viewportQuery = '(max-width: 768px)';
  backUrl!: string;
  boardBgUrl = '';

  deckMap = new Map<string, CardMeta>();
  spreads: SpreadDef[] = [];
  slots: Slot[] = [];
  placed: Placed[] = [];
  layers: Layer[] = [{ id: 1, cards: [] }];
  activeLayer = 0;
  layerOverlay = false;

  loadingDeck = true;
  deckReady = false;
  deckError: string | null = null;
  deckCount = 0;
  dealing = false;
  deckProgress = 0;
  deckShuffling = false;

  stepMode = false;
  private buffer: Placed[] = [];
  nextIdx = 0;
  freeLayout: FreeLayout = 'pile';
  focusIdx = 0;

  aiResponse = '';
  isInterpreting = false;
  interpretationText = '';
  showInterpretation = false;

  loading = false;
  showHistory = false;
  historyList: HistoryEntry[] = [];

  interpretationSafe: SafeHtml = '';
  lastDraw: DrawCard[] = [];

  userContextInput = '';
  userContext = '';

  showBookPanel = false;
  needsTerms = false;
  showMobileInterpretModal = false;

  showSavedReadings = false;
  savedReadingsLoading = false;
  savedReadings: SavedReadingSummary[] = [];
  savedDetail: SavedReadingDetail | null = null;
  savedDetailSafe: SafeHtml | null = null;
  savedDetailLoading = false;
  savedError: string | null = null;

  readonly hangingMenuItems = [
    { label: 'Mi cuenta', action: 'account' },
    { label: 'Configuración', action: 'settings' },
    { label: 'Lecturas guardadas', action: 'saved' },
    { label: 'Premium / Drucoins', action: 'premium' },
    { label: 'Cerrar sesión', action: 'logout' },
  ];

  readonly deckStack = Array.from({ length: 5 }, (_, i) => i);
  readonly interpretCost = 1;
  private activeModalContexts = new Set<string>();

  get canDeal() {
    return this.deckReady && !this.dealing;
  }
  get isFree() {
    return this.spreadId === 'free';
  }
  get activeCards(): Placed[] {
    return this.isFree ? this.layers[this.activeLayer]?.cards ?? [] : this.placed;
  }
  get hasEnoughDrucoins(): boolean {
    return this.drucoinBalance >= this.interpretCost;
  }

  private bgCandidates = [
    `${environment.CDN_BASE}/cards/celtic-cloth.webp`,
  ];

  showCardOverlay = false;
  overlayCardTitle = '';
  overlayCardMeaning = '';
  loadingCardMeaning = false;

  quota: { remaining: number; monthly: number } | null = null;
  drucoinBalance = 0;

  // === constructor ===
  constructor(private sanitizer: DomSanitizer) {
    this.backUrl =
      environment.CARD_BACK_URL ||
      `${environment.CDN_BASE}/cards/contracara.webp`;

    this.observeViewport();

    this.authService.quota$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((quota) => {
        this.quota = quota
          ? { monthly: quota.monthly, remaining: quota.remaining }
          : null;
        this.cdr.markForCheck();
      });

    this.authService.drucoinBalance$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((balance) => {
        this.drucoinBalance = balance ?? 0;
        this.cdr.markForCheck();
      });
  }

  // ============ ciclo de vida ============

  async ngOnInit() {
    this.authService.needsTerms$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((needs) => {
        this.needsTerms = needs;
        this.cdr.markForCheck();
      });

    const sessionStatus = await this.sessionService.validate(true);
    if (sessionStatus === 'invalid') {
      await this.router.navigate(['/login']);
      return;
    }

    const needsTerms =
      sessionStatus === 'needs-terms' ||
      (await this.authService.syncTermsStatus());
    this.needsTerms = needsTerms;
    this.cdr.markForCheck();

    this.resolveBgInBackground();
    await this.loadDeckFirst();
    this.rebuildSlots();
    this.loadSpreadsInBackground();

    const user = this.auth.currentUser;
    if (user) {
      const token = await user.getIdToken(true);
      const res = await fetch(`${environment.API_BASE}/history/list`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.ok) {
        this.historyList = data.history;
        this.writeHistory(data.history);
      }
    }
  }

  ngOnDestroy() {
    this.activeModalContexts.clear();
    if (typeof document !== 'undefined') {
      document.body.classList.remove('modal-open', 'interpret-open');
    }
  }

  async refreshQuota(force = false) {
    await this.sessionService.validate(force);
    this.cdr.markForCheck();
  }

  // ============ helpers DOM / viewport ============

  private setBodyModalState(context: string, active: boolean, extraClass?: string) {
    if (typeof document === 'undefined') return;

    if (active) {
      this.activeModalContexts.add(context);
      document.body.classList.add('modal-open');
      if (extraClass) document.body.classList.add(extraClass);
      return;
    }

    this.activeModalContexts.delete(context);
    if (this.activeModalContexts.size === 0) {
      document.body.classList.remove('modal-open');
    }
    if (extraClass) {
      document.body.classList.remove(extraClass);
    }
  }

  private resolveBgInBackground() {
    for (const url of this.bgCandidates) {
      const img = new Image();
      img.onload = () => {
        if (!this.boardBgUrl) this.boardBgUrl = url;
      };
      img.src = url;
    }
  }

  private hideInterpretationModal() {
    if (this.showInterpretation) {
      this.showInterpretation = false;
    }
    this.setBodyModalState('interpret-view', false, 'interpret-open');
  }

  private observeViewport() {
    this.isMobile = this.breakpointObserver.isMatched(this.viewportQuery);

    this.breakpointObserver
      .observe([this.viewportQuery])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ matches }) => {
        if (this.isMobile === matches) return;
        this.zone.run(() => {
          this.isMobile = matches;
          this.cdr.markForCheck();
        });
      });
  }

  // ============ drucoins / terms / lectura ============

  private ensureHasDrucoins(): boolean {
    if (this.hasEnoughDrucoins) return true;
    alert('No tienes DruCoins suficientes para interpretar la tirada.');
    return false;
  }

  private async ensureReadingAllowance(): Promise<boolean> {
    // 1) Términos
    if (this.needsTerms) {
      try {
        const accepted = await this.sessionService.ensureTermsAcceptance();
        this.needsTerms = !accepted;
        this.cdr.markForCheck();

        if (!accepted) {
          alert('Debes aceptar los Términos y Condiciones para continuar.');
          return false;
        }
      } catch (err) {
        console.error('Terms flow error desde Spreads:', err);
        alert('No se pudieron mostrar los Términos y Condiciones. Intenta de nuevo.');
        return false;
      }
    }

    // 2) Backend: cuota + DruCoins
    try {
      const token = await this.authService.getIdToken();
      if (!token) {
        await this.router.navigate(['/login']);
        return false;
      }

      const res = await fetch(`${environment.API_BASE}/reading/check`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) return true;

      if (res.status === 402) {
        const payload = await res.json().catch(() => ({}));
        if (payload?.reason === 'no_drucoins') {
          this.authService.updateDrucoinBalance(0);
        }
        alert(payload?.message || 'No tienes tiradas o DruCoins suficientes.');
        return false;
      }

      if (res.status === 401) {
        await this.authService.logout();
        await this.router.navigate(['/login']);
        return false;
      }

      return false;
    } catch (err) {
      console.error('reading check error', err);
      return false;
    }
  }

  private async afterSuccessfulDraw() {
    await this.refreshQuota(true);
  }

  // ============ card meaning overlay ============

  async openCardMeaning(pc: any) {
    try {
      const cardName =
        this.deckMap.get(pc.cardId)?.name || pc.cardId || 'Carta desconocida';

      this.showCardOverlay = true;
      this.overlayCardTitle = cardName;
      this.overlayCardMeaning = 'Consultando significado...';
      this.loadingCardMeaning = true;
      this.cdr.detectChanges();

      const res = await fetch(
        'https://lumiere-api.laife91.workers.dev/api/card-meaning',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: cardName,
            reversed: !!pc.reversed,
          }),
        }
      );

      if (!res.ok) {
        const errText = await res.text();
        console.error('Error al obtener significado:', res.status, errText);
        this.overlayCardMeaning = `Error ${res.status}: ${errText}`;
        this.loadingCardMeaning = false;
        this.cdr.detectChanges();
        return;
      }

      const data = await res.json();
      const meaning =
        data.meaning ||
        data.message ||
        'No se recibió interpretación del servidor.';
      this.overlayCardMeaning = meaning;
    } catch (err: any) {
      console.error('Error openCardMeaning:', err);
      this.overlayCardMeaning =
        'Error interno: ' + (err.message || 'desconocido');
    } finally {
      this.loadingCardMeaning = false;
      this.cdr.detectChanges();
    }
  }

  closeCardOverlay() {
    this.showCardOverlay = false;
    this.overlayCardTitle = '';
    this.overlayCardMeaning = '';
    this.loadingCardMeaning = false;
  }

  // ============ interpretación IA ============

  startInterpretation() {
    if (!this.activeCards.length || this.isInterpreting) return;
    if (!this.ensureHasDrucoins()) return;

    if (this.isMobile) {
      if (!this.userContextInput) {
        this.userContextInput = this.userContext || '';
      }
      this.showMobileInterpretModal = true;
      this.setBodyModalState('mobile-interpret', true);
      return;
    }
    this.confirmContext();
  }

  confirmContext() {
    if (this.isInterpreting) return;
    if (!this.ensureHasDrucoins()) return;

    this.userContext = (this.userContextInput || '').trim();
    if (!this.userContext) {
      alert('Por favor, escribe tu contexto o pregunta antes de continuar.');
      return;
    }
    this.runInterpretation();
  }

  confirmMobileInterpretation() {
    this.showMobileInterpretModal = false;
    this.setBodyModalState('mobile-interpret', false);
    this.confirmContext();
  }

  closeMobileInterpretation() {
    this.showMobileInterpretModal = false;
    this.setBodyModalState('mobile-interpret', false);
  }

  async runInterpretation() {
    if (this.isInterpreting) return;
    if (!(await this.ensureReadingAllowance())) return;

    this.hideInterpretationModal();

    try {
      this.isInterpreting = true;
      this.setBodyModalState('interpreting', true);
      this.aiResponse = '';
      this.interpretationText = '';

      const cards = this.placed.map((c) => ({
        name: c.cardId,
        reversed: c.reversed,
      }));

      const firebaseUser = this.auth.currentUser;
      const token = firebaseUser
        ? await firebaseUser.getIdToken(true)
        : await this.authService.getIdToken();

      if (!token) {
        await this.router.navigate(['/login']);
        return;
      }

      const res = await fetch(`${environment.API_BASE}/interpret`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          context: this.userContext,
          cards,
          spreadId: this.spreadId,
        }),
      });

      if (res.status === 402) {
        const payload = await res.json().catch(() => ({}));
        if (typeof payload?.drucoins === 'number') {
          this.authService.updateDrucoinBalance(payload.drucoins);
        }
        const message =
          payload?.message ||
          (payload?.error === 'NO_DRUCOINS'
            ? 'No tienes DruCoins suficientes para interpretar la tirada.'
            : 'No puedes interpretar la tirada en este momento.');
        alert(message);
        return;
      }

      const data = await res.json();
      if (typeof data?.drucoins === 'number') {
        this.authService.updateDrucoinBalance(data.drucoins);
      }

      if (data.ok && data.interpretation) {
        const interpretation = this.normalizeInterpretation(data.interpretation);
        this.interpretationText = interpretation;
        this.interpretationSafe = this.sanitizer.bypassSecurityTrustHtml(
          this.toHtml(interpretation)
        );
        this.showInterpretation = true;
        this.setBodyModalState('interpret-view', true, 'interpret-open');
        await this.saveReading();
      } else {
        alert('No se recibió interpretación.');
      }
    } catch (err) {
      alert('Error interpretando la tirada.');
      console.error(err);
    } finally {
      this.isInterpreting = false;
      this.setBodyModalState('interpreting', false);
      this.cdr.markForCheck();
    }
  }

  async saveReading() {
    try {
      const user = this.auth.currentUser;
      if (!user) {
        alert('Inicia sesión para guardar lecturas.');
        return;
      }
      const token = await user.getIdToken(true);
      const payload = {
        title: `Lectura ${new Date().toLocaleString()}`,
        interpretation: this.interpretationText,
        cards: this.placed.map((c) => ({
          id: c.cardId,
          reversed: c.reversed,
          pos: c.position,
        })),
        spreadId: this.spreadId,
      };

      const res = await fetch(`${environment.API_BASE}/readings/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 402) {
        const msg = await res.text();
        alert(
          msg ||
            'Has alcanzado el máximo (5). Pasa a Sabiduría o dona para ampliar.'
        );
        return;
      }

      if (!res.ok) throw new Error(await res.text());
      alert('Lectura guardada.');
    } catch (e: any) {
      alert('No se pudo guardar. ' + (e?.message || ''));
    }
  }

  setInterpretation(text: string) {
    const normalized = this.normalizeInterpretation(text ?? '');
    this.interpretationText = normalized;
    this.interpretationSafe = this.sanitizer.bypassSecurityTrustHtml(
      this.toHtml(normalized)
    );
  }

  // ============ deck & spreads ============

  async loadDeckFirst() {
    this.loadingDeck = true;
    this.deckError = null;
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
      this.loader
        .preloadAll([this.backUrl], 12000, { ignoreErrors: true })
        .catch(() => {});
      this.bumpDeckProgress(100, 900);
    } catch (e: any) {
      this.zone.run(() => {
        this.deckError = e?.message ?? 'No se pudo cargar el mazo';
        this.deckReady = false;
        this.deckCount = 0;
        this.loadingDeck = false;
        this.cdr.markForCheck();
      });
    }
  }

  private loadSpreadsInBackground() {
    this.api.spreads().subscribe({
      next: (s) => (this.spreads = s),
      error: () => {},
    });
  }

  onSpreadChange() {
    this.spreadLabel =
      this.spreadId === 'celtic-cross-10'
        ? 'Cruz Celta'
        : this.spreadId === 'ppf-3'
        ? 'Pasado · Presente · Futuro'
        : 'Libre';

    this.rebuildSlots();
    this.placed = [];

    if (this.isFree) {
      this.layers = [{ id: 1, cards: [] }];
      this.activeLayer = 0;
    }
  }

  private rebuildSlots() {
    const layout = this.buildLayout(this.spreadId);
    this.slots = layout.map((p) => ({ ...p }));
  }

  getFrontUrl(cardId?: string): string | undefined {
    if (!cardId) return undefined;

    const aliasMap: Record<string, string> = {
      // Bastos
      'wands-11': 'pagedebastos',
      'wands-12': 'caballerodebastos',
      'wands-13': 'reinadebastos',
      'wands-14': 'reydebastos',
      // Espadas
      'swords-11': 'pagedeespadas',
      'swords-12': 'caballerodeespadas',
      'swords-13': 'reinadeespadas',
      'swords-14': 'reydeespadas',
      // Copas
      'cups-11': 'pagedecopas',
      'cups-12': 'caballerodecopas',
      'cups-13': 'reinadecopas',
      'cups-14': 'reydecopas',
      // Pentáculos (si tuvieras alias distintos)
    };

    const fixedId = aliasMap[cardId] ?? cardId;
    const meta = this.deckMap.get(fixedId);

    if (!meta) {
      console.warn(`Carta sin meta en deckMap: ${fixedId} (original: ${cardId})`);
      return `${environment.CDN_BASE}/cards/${fixedId}.webp`;
    }

    if (!meta.imageUrl) {
      console.warn(`Carta sin imageUrl asignada: ${fixedId}`);
      return `${environment.CDN_BASE}/cards/${fixedId}.webp`;
    }
    return meta.imageUrl;
  }

  toggleShuffle() {
    this.deckShuffling = !this.deckShuffling;
    if (this.deckShuffling)
      setTimeout(() => (this.deckShuffling = false), 1600);
  }

  private bumpDeckProgress(target = 100, ms = 800) {
    const start = this.deckProgress;
    const steps = 20;
    const inc = (target - start) / steps;
    const dt = Math.max(12, ms / steps);
    let i = 0;
    const t = setInterval(() => {
      this.deckProgress = Math.min(
        100,
        Math.round(start + inc * ++i)
      );
      if (i >= steps) clearInterval(t);
    }, dt);
  }

  // ============ hacer tirada ============

  async hacerTirada() {
    if (!this.canDeal) return;
    if (!(await this.ensureReadingAllowance())) return;

    console.groupCollapsed(
      '%c[🔮 hacerTirada: inicio]',
      'color:violet'
    );
    this.dealing = true;
    this.placed = [];

    try {
      const user = this.auth.currentUser;
      const uid = user?.uid ?? 'guest';
      const token = user ? await user.getIdToken(true) : '';

      console.log(
        '🪄 Solicitando tirada para UID:',
        uid,
        'Spread:',
        this.spreadId
      );

      const res: DrawResult = await this.api.drawWithAuth(
        this.spreadId,
        uid,
        token
      );
      if (!res?.cards?.length)
        throw new Error('No se recibieron cartas del servidor');

      const validCards = res.cards.filter((c) => !!c.cardId);
      console.table(
        validCards.map((v) => ({ cardId: v.cardId, reversed: v.reversed }))
      );

      const withPos: Placed[] = validCards.map((c, i) => {
        const p =
          this.slots[i] || {
            x: 50,
            y: 50,
            r: 0,
            z: 10 + i,
            position: i + 1,
          };
        return {
          ...p,
          cardId: c.cardId,
          reversed: !!c.reversed,
          delay: i * 100,
          dealt: false,
          faceup: false,
          layer: 0,
        };
      });

      console.table(
        withPos.map((c) => ({
          pos: c.position,
          id: c.cardId,
          r: c.r,
          x: c.x,
          y: c.y,
        }))
      );

      const fronts = withPos
        .map((pc) => this.getFrontUrl(pc.cardId))
        .filter(Boolean) as string[];

      const preloadRes = await this.loader.preloadAll(
        [this.backUrl, ...fronts],
        45000,
        { ignoreErrors: true }
      );
      console.log('📦 Preload completado:', preloadRes);

      const placeholder = `${environment.CDN_BASE}/cards/contracara.webp`;
      const failFlat = preloadRes.fail ?? [];
      withPos.forEach((pc) => {
        const url = this.getFrontUrl(pc.cardId);
        if (!url || failFlat.includes(url)) {
          console.warn(
            `⚠️ Carta ${pc.cardId} falló en preload, usando placeholder`
          );
          this.deckMap.set(
            pc.cardId,
            {
              id: pc.cardId,
              imageUrl: placeholder,
              name: pc.cardId,
            } as any
          );
        }
      });

      this.placed = withPos;

      let baseDelay = 120;
      const fps = await this.getApproxFPS();
      if (fps < 50) baseDelay = 180;
      if (fps < 30) baseDelay = 250;
      console.log('🎥 FPS aproximado:', fps, '→ baseDelay:', baseDelay);

      document.body.classList.add('spread-active');

      this.zone.runOutsideAngular(async () => {
        const tasks = withPos.map(
          (pc, i) =>
            new Promise<void>(async (resolve) => {
              try {
                await new Promise((r) =>
                  setTimeout(
                    r,
                    i * (baseDelay + Math.random() * 80)
                  )
                );
                this.zone.run(() => {
                  pc.dealt = true;
                  this.cdr.detectChanges();
                });
                await new Promise((r) => setTimeout(r, 350));
                this.zone.run(() => {
                  pc.faceup = true;
                  this.cdr.detectChanges();
                  console.log(
                    `🃏 Carta girada: #${pc.position} (${pc.cardId})`
                  );
                });
                resolve();
              } catch (e) {
                console.error(
                  '❌ Error animando carta',
                  pc.cardId,
                  e
                );
                resolve();
              }
            })
        );
        await Promise.allSettled(tasks);

        this.zone.run(() => {
          const pending = this.placed.filter((c) => !c.faceup);
          if (pending.length) {
            console.warn(
              '🌀 Reintentando girar cartas pendientes:',
              pending.map((c) => c.cardId)
            );
            pending.forEach((c) => (c.faceup = true));
            this.cdr.detectChanges();
          }

          const missingMeta = this.placed.filter(
            (c) => !this.deckMap.get(c.cardId)
          );
          if (missingMeta.length) {
            console.warn(
              '⚠️ Cartas sin meta en deckMap:',
              missingMeta.map((c) => c.cardId)
            );
          }

          this.dealing = false;
          this.saveToHistory();
          this.afterSuccessfulDraw();
          document.body.classList.remove('spread-active');
          document.body.classList.add('spread-complete');
          setTimeout(
            () => document.body.classList.remove('spread-complete'),
            800
          );
          console.groupEnd();
        });
      });
    } catch (err: any) {
      console.error('❌ Error en hacerTirada:', err);
      this.deckError = err.message;
      this.dealing = false;
      console.groupEnd();
    }
  }

  // ============ historia local/remota ============

  async saveToHistory() {
    const cards = this.isFree
      ? this.layers[this.activeLayer].cards
      : this.placed;
    if (!cards.length) return;

    const entry: HistoryEntry = {
      id: crypto?.randomUUID?.() ?? String(Date.now()),
      spreadId: this.spreadId,
      spreadLabel: this.spreadLabel,
      cards: JSON.parse(JSON.stringify(cards)),
      ts: Date.now(),
    };

    const list = this.readHistory();
    list.unshift(entry);
    this.writeHistory(list);

    const user = this.auth.currentUser;
    if (user) {
      try {
        const token = await user.getIdToken(true);
        await fetch(`${environment.API_BASE}/history/save`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(entry),
        });
      } catch (err) {
        console.warn('⚠️ No se pudo sincronizar historial remoto:', err);
      }
    }
  }

  async openHistory(e?: MouseEvent) {
    e?.stopPropagation();
    this.closeCardOverlay();
    this.hideInterpretationModal();

    let list: HistoryEntry[] = [];
    const user = this.auth.currentUser;

    if (user) {
      try {
        const token = await user.getIdToken(true);
        const res = await fetch(`${environment.API_BASE}/history/list`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          list = data.history ?? [];
        }
      } catch (err) {
        console.warn(
          '⚠️ Error cargando historial remoto, uso local:',
          err
        );
      }
    }

    if (!list.length) {
      list = this.readHistory();
    }

    let changed = false;
    list = list.map((e) => {
      if (e.ts == null) {
        e.ts = Date.now();
        changed = true;
      }
      return e;
    });
    if (changed) this.writeHistory(list);

    this.historyList = list;
    this.showHistory = true;
    this.setBodyModalState('history', true);
    this.cdr.detectChanges();
  }

  closeHistory() {
    this.showHistory = false;
    this.showCardOverlay = false;
    this.showInterpretation = false;
    this.layerOverlay = false;
    this.setBodyModalState('history', false);
    document.body.classList.remove('spread-complete');
    document
      .querySelector('.board')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.cdr.detectChanges();
  }

  async deleteHistory(id: string) {
    if (!confirm('¿Eliminar esta lectura para siempre?')) return;

    const list = this.readHistory().filter((e) => e.id !== id);
    this.writeHistory(list);
    this.historyList = list;

    const user = this.auth.currentUser;
    if (user) {
      try {
        const token = await user.getIdToken(true);
        await fetch(`${environment.API_BASE}/history/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        console.warn('⚠️ No se pudo borrar en servidor:', err);
      }
    }
  }

  loadHistory(h: HistoryEntry) {
    this.showHistory = false;
    this.spreadId = h.spreadId;
    this.spreadLabel = h.spreadLabel;
    this.onSpreadChange();

    if (h.spreadId === 'free') {
      this.layers = [{ id: 1, cards: JSON.parse(JSON.stringify(h.cards)) }];
      this.activeLayer = 0;
    } else {
      this.placed = JSON.parse(JSON.stringify(h.cards));
    }
  }

  // ============ layout / drag ============

  private buildLayout(id: string) {
    if (id === 'celtic-cross-10') return this.celticCross10();
    if (id === 'ppf-3') return this.ppf3();
    return this.free9();
  }

  private celticCross10() {
    const Cx = 45,
      Cy = 50;
    const dx = 15,
      dy = 13;
    const colX = 78;
    const h = 12;

    return [
      { position: 1, x: 50, y: 45, r: 0, z: 28 },
      { position: 2, x: 50, y: 45, r: 90, z: 31 },
      { position: 3, x: Cx, y: Cy + dy, r: 0, z: 19 },
      { position: 4, x: Cx - dx, y: Cy, r: 0, z: 19 },
      { position: 5, x: Cx, y: Cy - dy, r: 0, z: 19 },
      { position: 6, x: Cx + dx, y: Cy, r: 0, z: 19 },
      { position: 7, x: colX, y: Cy + h, r: 0, z: 18 },
      { position: 8, x: colX, y: Cy, r: 0, z: 18 },
      { position: 9, x: colX, y: Cy - h, r: 0, z: 18 },
      { position: 10, x: colX, y: Cy - 2 * h, r: 0, z: 18 },
    ];
  }

  private ppf3() {
    return [
      { position: 1, x: 35, y: 52, r: 0, z: 10 },
      { position: 2, x: 50, y: 52, r: 0, z: 11 },
      { position: 3, x: 65, y: 52, r: 0, z: 12 },
    ];
  }

  private free9() {
    const baseX = 50,
      baseY = 52;
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    return Array.from({ length: 9 }, (_, i) => ({
      position: i + 1,
      x: baseX + rand(-6, 6),
      y: baseY + rand(-6, 6),
      r: rand(-8, 8),
      z: 20 + i,
    }));
  }

  onDragEnd(pc: Placed, ev: CdkDragEnd) {
    const el = ev.source.getRootElement() as HTMLElement;
    const board = el.closest('.board') as HTMLElement;
    if (!board) return;
    const rect = board.getBoundingClientRect();
    const cx = el.getBoundingClientRect().left + el.offsetWidth / 2;
    const cy = el.getBoundingClientRect().top + el.offsetHeight / 2;
    pc.x = ((cx - rect.left) / rect.width) * 100;
    pc.y = ((cy - rect.top) / rect.height) * 100;
  }

  onCardClick(pc: Placed, ev: MouseEvent) {
    ev.stopPropagation();
    pc.faceup = !pc.faceup;
    const maxZ = Math.max(...this.activeCards.map((p) => p.z));
    pc.z = maxZ + 1;
  }

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
    const maxZ = Math.max(...arr.map((p) => p.z));
    arr[i].z = maxZ + 1;
  }

  onDeckClick() {
    if (!this.canDeal) {
      this.toggleShuffle();
      return;
    }

    if (this.spreadId === 'celtic-cross-10') {
      if (this.stepMode) {
        if (!this.buffer.length || this.nextIdx === 0) {
          this.prepararCruzPasoAPaso().then(() =>
            this.colocarSiguientePosicion()
          );
        } else {
          this.colocarSiguientePosicion();
        }
      } else {
        this.repartirCruzCompleta();
      }
      return;
    }

    if (this.isFree) {
      this.agregarCartaLibre(1);
      return;
    }

    this.hacerTirada();
  }

  async repartirCruzCompleta() {
    if (!this.canDeal) return;
    this.stepMode = false;
    this.spreadId = 'celtic-cross-10';
    this.onSpreadChange();
    await this.hacerTirada();
  }

  async prepararCruzPasoAPaso() {
    if (!this.deckReady) return;
    this.stepMode = true;
    this.spreadId = 'celtic-cross-10';
    this.onSpreadChange();
    this.dealing = true;

    const res: DrawResult = await firstValueFrom(
      this.api.draw('celtic-cross-10')
    );
    const mapped: Placed[] = res.cards.map((c, i) => {
      const p =
        this.slots[i] || {
          x: 50,
          y: 50,
          r: 0,
          z: 10 + i,
          position: i + 1,
        };
      return {
        position: p.position,
        cardId: c.cardId,
        reversed: c.reversed,
        x: p.x,
        y: p.y,
        r: p.r,
        z: p.z,
        delay: 0,
        dealt: false,
        faceup: false,
        layer: 0,
      };
    });

    try {
      const fronts = mapped
        .map((m) => this.getFrontUrl(m.cardId))
        .filter(Boolean) as string[];
      this.loader
        .preloadAll([this.backUrl, ...fronts], 60000, { ignoreErrors: true })
        .catch(() => {});
    } catch {}

    this.placed = [];
    this.buffer = mapped;
    this.nextIdx = 0;
    this.dealing = false;
  }

  colocarSiguientePosicion() {
    if (!this.stepMode || this.nextIdx >= this.buffer.length) return;
    const pc = this.buffer[this.nextIdx++];
    this.placed.push(pc);
    setTimeout(() => {
      pc.dealt = true;
      setTimeout(() => {
        pc.faceup = true;
        if (this.nextIdx >= this.buffer.length) this.saveToHistory();
      }, 350);
    });
  }

  // ============ libre ============

  agregarCartaLibre(n = 1) {
    if (!this.deckReady) return;

    const used = new Set<string>(
      this.layers.flatMap((l) => l.cards.map((c) => c.cardId))
    );
    const allIds = Array.from(this.deckMap.keys());
    const pool = allIds.filter((id) => !used.has(id));
    if (!pool.length) return;

    const target = this.layers[this.activeLayer];
    if (!target) return;

    const room = Math.max(0, 10 - target.cards.length);
    let toCurrent = Math.min(room, n);
    let remaining = n - toCurrent;

    if (toCurrent > 0) {
      const cards = this.generateFreeCards(pool, toCurrent, this.activeLayer);
      target.cards.push(...cards);
      this.runDealAnimation(cards);
    }

    while (remaining > 0) {
      this.createNextLayer();
      const fresh = allIds.filter(
        (id) =>
          !this.layers
            .flatMap((l) => l.cards)
            .some((c) => c.cardId === id)
      );
      const cards = this.generateFreeCards(
        fresh,
        Math.min(10, remaining),
        this.activeLayer
      );
      this.layers[this.activeLayer].cards.push(...cards);
      this.runDealAnimation(cards);
      remaining -= cards.length;
    }
  }

  private generateFreeCards(
    pool: string[],
    count: number,
    layerIndex: number
  ): Placed[] {
    const out: Placed[] = [];
    for (let i = 0; i < count && pool.length; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      const cardId = pool.splice(idx, 1)[0];
      const reversed = Math.random() < 0.5;
      const p = this.layoutFreePosition(this.freeLayout, i);
      out.push({
        position: p.position,
        cardId,
        reversed,
        x: p.x,
        y: p.y,
        r: p.r,
        z: 20 + i,
        delay: i * 60,
        dealt: false,
        faceup: false,
        layer: layerIndex,
      });
    }

    const urls = out
      .map((c) => this.getFrontUrl(c.cardId))
      .filter(Boolean) as string[];
    this.loader
      .preloadAll([this.backUrl, ...urls], 60000, { ignoreErrors: true })
      .catch(() => {});
    return out;
  }

  private layoutFreePosition(kind: FreeLayout, i: number) {
    if (kind === 'grid') {
      const cols = 5,
        gx = 12,
        gy = 16;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = 30 + col * gx;
      const y = 30 + row * gy;
      return {
        position: i + 1,
        x: Math.min(85, x),
        y: Math.min(80, y),
        r: 0,
      };
    }
    if (kind === 'fan') {
      const cx = 50,
        cy = 58;
      const base = -15,
        step = 6;
      const r = base + i * step;
      const rad = (r * Math.PI) / 180;
      const R = 16;
      const x = cx + R * Math.sin(rad);
      const y = cy - R * Math.cos(rad);
      return { position: i + 1, x, y, r };
    }
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    return {
      position: i + 1,
      x: 50 + rand(-6, 6),
      y: 52 + rand(-6, 6),
      r: rand(-8, 8),
    };
  }

  private createNextLayer() {
    const id = this.layers.length + 1;
    this.layers.push({ id, cards: [] });
    this.activeLayer = this.layers.length - 1;
    this.layerOverlay = true;
    setTimeout(() => (this.layerOverlay = false), 500);
  }

  switchLayer(i: number) {
    if (i >= 0 && i < this.layers.length) this.activeLayer = i;
  }

  private runDealAnimation(cards: Placed[]) {
    setTimeout(() => {
      cards.forEach((pc, i) => {
        setTimeout(() => {
          pc.dealt = true;
          setTimeout(() => (pc.faceup = true), 300);
        }, i * 100);
      });
      this.saveToHistory();
    });
  }

  // ============ util varios ============

  private getApproxFPS(): Promise<number> {
    let frames = 0;
    const start = performance.now();
    return new Promise<number>((resolve) => {
      function loop() {
        frames++;
        if (performance.now() - start < 1000) {
          requestAnimationFrame(loop);
        } else {
          resolve(frames);
        }
      }
      requestAnimationFrame(loop);
    });
  }

  private requireUserToken = async (): Promise<string | null> => {
    const user = this.auth.currentUser;
    if (!user) {
      alert('Inicia sesión para usar esta función.');
      return null;
    }
    return user.getIdToken(true);
  };

  extractHighlights(text: string): string[] {
    if (!text) return [];
    const sentences = text
      .split(/[.!?]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 25)
      .slice(0, 5);
    return sentences;
  }

  private toHtml(s: string): string {
    const esc = (t: string) =>
      t.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    return esc(s)
      .split(/\n{2,}/g)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  private normalizeInterpretation(text: string): string {
    if (!text) return '';
    return text;
  }

  // ============ tracking helpers para *ngFor ============

  trackSlot(_index: number, slot: Slot): number {
    return slot.position;
  }

  trackCard(_index: number, card: Placed): string {
    return `${card.layer}-${card.position}-${card.cardId}`;
  }

  trackDeck(_index: number, item: number): number {
    return item;
  }

  trackHistoryEntry(_index: number, entry: HistoryEntry): string {
    return entry.id;
  }

  trackById(_index: number, item: { id: string }): string {
    return item.id;
  }

  // ============ UI varias / menú colgante ============

  toggleBookPanel() {
    this.showBookPanel = !this.showBookPanel;
  }

  openSavedReadings() {
    // De momento reuso el historial
    this.openHistory();
  }

  openSubscription() {
    console.log('openSubscription clicked');
  }

  openProfile() {
    console.log('openProfile clicked');
  }

  openPrivacy() {
    console.log('openPrivacy clicked');
  }

  toggleSettings() {
    console.log('toggleSettings clicked');
  }

  handleMenuAction(action: string) {
    switch (action) {
      case 'logout':
        this.logout();
        break;
      case 'saved':
        this.openSavedReadings();
        break;
      case 'account':
        this.openProfile();
        break;
      case 'settings':
        this.toggleSettings();
        break;
      case 'premium':
        this.openSubscription();
        break;
      default:
        console.log('menu action', action);
    }
  }

  async logout() {
    try {
      await this.authService.logout();
    } finally {
      await this.router.navigate(['/login']);
    }
  }

  closeInterpret() {
    this.hideInterpretationModal();
  }

  setLastDraw(cards: DrawCard[]) {
    this.lastDraw = Array.isArray(cards) ? cards : [];
  }

  formatTs(ts: number) {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  private readHistory(): HistoryEntry[] {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch {
      return [];
    }
  }

  private writeHistory(list: HistoryEntry[]) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {}
  }
}
