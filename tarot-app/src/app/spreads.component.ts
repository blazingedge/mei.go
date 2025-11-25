  // =======================
  //  SPREADS COMPONENT
  //  DRUCOINS ONLY — FULL DEBUG
  //  PARTE 1 / 4
  // =======================

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

  // ==========================
  // TYPES
  // ==========================

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

  const HISTORY_KEY = 'tarot-history-v1';

  // ===============================
  // COMPONENT
  // ===============================

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

    // ============================================
    // INJECCIONES
    // ============================================

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
    private session = inject(SessionService);
    
    // ============================================
    // ESTADO PRINCIPAL
    // ============================================

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

    loading = false;

    // Imagen de loading místico
    loadingWizardMobile: string = `${environment.CDN_BASE}/cards/magoceltaloading.gif`;
    loadingWizardDesktop: string = `${environment.CDN_BASE}/cards/magoceltaloading_mobile.webp`;

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

    // COSTE DE INTERPRETACIÓN (1 Drucoin)
    readonly interpretCost = 1;

    drucoinBalance = 0;

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

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(private sanitizer: DomSanitizer) {

      console.debug('%c[INIT] SpreadsComponent constructor()', 'color:#66f');

      this.backUrl =
        environment.CARD_BACK_URL ||
        `${environment.CDN_BASE}/cards/contracara.webp`;

      // Observador para móvil/desktop
      this.observeViewport();

      // Solo manejamos DRUCOINS ahora
      this.authService.drucoinBalance$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((balance) => {
          console.debug('%c[DruCoins Updated]', 'color:#0f0', balance);
          this.drucoinBalance = balance ?? 0;
          this.cdr.markForCheck();
        });
    }

    // ============================================
    // CICLO DE VIDA
    // ============================================

    async ngOnInit() {

    console.group('%c[SpreadsComponent INIT]', 'color:#66f');

    this.authService.needsTerms$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((needs) => {
        console.debug('→ needsTerms updated:', needs);
        this.needsTerms = needs;
        this.cdr.markForCheck();
      });

    const sessionStatus = await this.sessionService.validate(true);
    console.debug('→ Session validate result:', sessionStatus);

    // ⭐ FIX: sincronizar DruCoins REALES tras validate()
    const snap = this.sessionService.snapshot;
    console.debug('→ Synced drucoins from SessionService:', snap.drucoins);

    this.drucoinBalance = snap.drucoins;
    this.authService.updateDrucoinBalance(snap.drucoins);
    let needsTerms = !!snap.needsTerms;
    this.historyList = this.normalizeHistoryList(this.readHistory());
    this.cdr.markForCheck();

    if (sessionStatus === 'invalid') {
      console.warn('⚠️ Sesión inválida. Redirigiendo a login.');
      await this.router.navigate(['/login']);
      console.groupEnd();
      return;
    }

    if (sessionStatus === 'needs-terms') {
      needsTerms = true;
    } else if (!needsTerms) {
      needsTerms = await this.authService.syncTermsStatus();
    }

    console.debug('→ needsTerms (sync):', needsTerms);

    this.needsTerms = needsTerms;
    if (needsTerms) {
      this.authService.requireTermsAcceptance();
    } else {
      this.authService.markTermsAccepted();
    }
    this.cdr.markForCheck();

    this.resolveBgInBackground();

    await this.loadDeckFirst();
    this.rebuildSlots();
    this.loadSpreadsInBackground();

    const user = this.auth.currentUser;

    if (user) {
      const token = await user.getIdToken(true);
      console.debug('→ Loading history from API...');

      const res = await fetch(`${environment.API_BASE}/history/list`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json();
      if (data?.ok && Array.isArray(data.history)) {
        console.debug('→ Remote history loaded:', data.history);
        const normalized = this.normalizeHistoryList(data.history);
        this.historyList = normalized;
        this.writeHistory(normalized);
        this.cdr.markForCheck();
      }
    }

    console.groupEnd();
  }


    ngOnDestroy() {
      console.debug('%c[DESTROY] SpreadsComponent', 'color:red');
      this.activeModalContexts.clear();
      if (typeof document !== 'undefined') {
        document.body.classList.remove('modal-open', 'interpret-open');
      }
    }

    // ============================================
  // DRUCOINS / TERMS / LECTURA — PARTE 2 / 4
  // ============================================

  // ---------------------------
  // Verificación de saldo
  // ---------------------------

  // ======================================================
  // PARTE 1 — VIEWPORT + BACKGROUND
  // ======================================================


  get loadingWizardurl(): string {
    return this.isMobile ? this.loadingWizardMobile : this.loadingWizardDesktop;
  }


  private ensureHasDrucoins(): boolean {
    console.groupCollapsed('%c[Drucoins] ensureHasDrucoins()', 'color:#0ff');

    console.log('→ Balance actual:', this.drucoinBalance);
    console.log('→ InterpretCost:', this.interpretCost);

    if (this.drucoinBalance >= this.interpretCost) {
      console.log('✔ Suficientes DruCoins');
      console.groupEnd();
      return true;
    }

    console.warn('❌ No hay suficientes DruCoins');
    alert('No tienes DruCoins suficientes para interpretar la tirada.');

    console.groupEnd();
    return false;
  }

  // ---------------------------
  // Verificación de lectura (Términos + Drucoins)
  // ---------------------------
  async ensureReadingAllowance(): Promise<boolean> {
    console.group('%c[ReadingCheck] ensureReadingAllowance()', 'color:#fb6');

    // 1) Validar sesión: ok / needs-terms / invalid
    const status = await this.session.validate();

    if (status === 'invalid') {
      console.warn('❌ Sesión inválida. Redirigir a login.');
      this.router.navigate(['/login']);
      console.groupEnd();
      return false;
    }

    // 2) Si faltan términos → abrir modal y aceptar
    if (status === 'needs-terms') {
      console.log('⚠ Usuario requiere aceptar términos.');
      const accepted = await this.session.ensureTermsAcceptance();

      if (!accepted) {
        console.warn('❌ Usuario canceló términos.');
        console.groupEnd();
        return false;
      }

      console.log('✔ Términos aceptados.');
    }

    // 3) NO existe /reading/check → se elimina chequeo
    console.log('→ Verificación DruCoins delegada a /interpret');

    // 4) Si pasó todo → permitido
    console.log('✔ Permiso preliminar concedido');
    console.groupEnd();
    return true;
  }


  // =======================================================
  // INTERPRETACIÓN IA (principal flujo) — DRUCOINS
  // =======================================================

  startInterpretation() {
    console.group('%c[Interpretation] startInterpretation()', 'color:#f0f');

    if (!this.activeCards.length) {
      console.warn('⚠️ No hay cartas activas');
      console.groupEnd();
      return;
    }

    if (this.isInterpreting) {
      console.warn('⚠️ Ya está interpretando');
      console.groupEnd();
      return;
    }

    if (!this.ensureHasDrucoins()) {
      console.warn('❌ No tiene DruCoins suficientes');
      console.groupEnd();
      return;
    }

    if (this.isMobile) {
      console.log('→ Interpretación móvil: abriendo modal');
      if (!this.userContextInput) {
        this.userContextInput = this.userContext || '';
      }
      this.showMobileInterpretModal = true;
      this.setBodyModalState('mobile-interpret', true);

      console.groupEnd();
      return;
    }

    console.log('→ Desktop interpretation → confirmContext()');
    console.groupEnd();

    this.confirmContext();
  }

  confirmContext() {
    console.group('%c[Interpretation] confirmContext()', 'color:#0ff');

    if (this.isInterpreting) {
      console.warn('⚠️ Ya interpretando…');
      console.groupEnd();
      return;
    }

    if (!this.ensureHasDrucoins()) {
      console.warn('❌ No DruCoins');
      console.groupEnd();
      return;
    }

    this.userContext = (this.userContextInput || '').trim();
    console.log('→ Context:', this.userContext);

    if (!this.userContext) {
      alert('Por favor, escribe un contexto antes de continuar.');
      console.groupEnd();
      return;
    }

    console.log('→ Ejecutando runInterpretation()');

    console.groupEnd();
    this.runInterpretation();
  }

  confirmMobileInterpretation() {
    console.debug('[Mobile] confirmMobileInterpretation()');

    this.showMobileInterpretModal = false;
    this.setBodyModalState('mobile-interpret', false);
    this.confirmContext();
  }

  closeMobileInterpretation() {
    console.debug('[Mobile] closeMobileInterpretation()');
    this.showMobileInterpretModal = false;
    this.setBodyModalState('mobile-interpret', false);
  }


  // ============================================================
  // PARTE 3 — DECK / SPREADS / HISTORY / TIRADAS
  // ============================================================


  // ------------------------------------------------------------
  //  Cargar mazo completo (llamado al inicio y botón "Reintentar")
  // ------------------------------------------------------------
  async loadDeckFirst() {
    console.group('%c[Deck] loadDeckFirst()', 'color:#4fc3f7');

    this.loadingDeck = true;
    this.deckError = null;
    this.deckReady = false;
    this.deckMap.clear();

    try {
      console.log('→ Llamando API: /decks');
      const cards = await firstValueFrom(this.api.loadDeck());

      console.log('→ Deck recibido:', cards);

      for (const card of cards) {
        this.deckMap.set(card.id, card);
      }

      this.deckCount = cards.length;
      this.deckReady = true;
      console.log(`✔ Mazo cargado (${this.deckCount} cartas)`);

    } catch (err) {
      console.error('❌ Error cargando mazo', err);
      this.deckError = 'No se pudo cargar el mazo.';
    } finally {
      this.loadingDeck = false;
      this.cdr.markForCheck();
      console.groupEnd();
    }
  }



  // ------------------------------------------------------------
  //  Shuffle visual (solo animación)
  // ------------------------------------------------------------
  toggleShuffle() {
    console.group('%c[Deck] toggleShuffle()', 'color:#ffd54f');

    this.deckShuffling = true;

    setTimeout(() => {
      this.deckShuffling = false;
      console.log('→ Shuffle finalizado');
      this.cdr.markForCheck();
      console.groupEnd();
    }, 800);
  }


  // ------------------------------------------------------------
  //  Preparar slots del layout según tipo de tirada
  // ------------------------------------------------------------
  rebuildSlots() {
    console.group('%c[Layout] rebuildSlots()', 'color:#ce93d8');

    const layout = this.buildLayout(this.spreadId);
    this.slots = layout.map((s) => ({ ...s }));

    console.log('→ Slots generados:', this.slots);

    console.groupEnd();
  }


  // ------------------------------------------------------------
  // Cargar definiciones de spreads desde API
  // ------------------------------------------------------------
  async loadSpreadsInBackground() {
    console.group('%c[Spreads] loadSpreadsInBackground()', 'color:#ffb74d');

    try {
      const list = await firstValueFrom(this.api.getSpreads());
      console.log('→ Spreads recibidos:', list);

      this.spreads = list;
    } catch (err) {
      console.error('❌ Error cargando spreads', err);
    } finally {
      this.cdr.markForCheck();
      console.groupEnd();
    }
  }


  // ------------------------------------------------------------
  // Cambio de tirada (selector <select>)
  // ------------------------------------------------------------
  onSpreadChange() {
    console.group('%c[Spreads] onSpreadChange()', 'color:#64b5f6');
    console.log('→ spreadId:', this.spreadId);

    this.rebuildSlots();
    this.placed = [];
    this.layers = [{ id: 1, cards: [] }];
    this.activeLayer = 0;

    console.groupEnd();
  }


  // ------------------------------------------------------------
  // Generar URL de la carta (front)
  // ------------------------------------------------------------
  getFrontUrl(id: string | undefined | null): string {
    if (!id) return '';

    return `${environment.CDN_BASE}/cards/${id}.webp`;
  }


  // ------------------------------------------------------------
  // Hacer tirada normal (para PPF-3 y free de 9)
  // ------------------------------------------------------------
  async hacerTirada() {
    console.group('%c[Draw] hacerTirada()', 'color:#4db6ac');

    if (!this.deckReady) {
      console.warn('⚠️ Mazo no listo');
      console.groupEnd();
      return;
    }

    this.dealing = true;

    try {
      console.log('→ Llamando API draw:', this.spreadId);
      const res: DrawResult = await firstValueFrom(this.api.draw(this.spreadId));

      console.log('→ Resultado:', res);
      this.lastDraw = res.cards;

      const mapped: Placed[] = res.cards.map((c, i) => {
        const slot = this.slots[i];
        return {
          position: slot.position,
          cardId: c.cardId,
          reversed: c.reversed,
          x: slot.x,
          y: slot.y,
          r: slot.r,
          z: slot.z,
          delay: 0,
          dealt: false,
          faceup: false,
          layer: 0,
        };
      });

      // Precarga imágenes
      try {
        const urls = mapped.map((m) => this.getFrontUrl(m.cardId));
        await this.loader.preloadAll([this.backUrl, ...urls], 60000, {
          ignoreErrors: true,
        });
      } catch {}

      this.placed = [];
      this.placed = mapped;

      // Animación de reparto
      setTimeout(() => {
        this.placed.forEach((pc, i) => {
          setTimeout(() => {
            pc.dealt = true;
            setTimeout(() => (pc.faceup = true), 280);
          }, i * 140);
        });
      });

      // Guardar
      this.saveToHistory();

    } catch (err) {
      console.error('❌ Error haciendo tirada', err);
    } finally {
      this.dealing = false;
      this.cdr.markForCheck();
      console.groupEnd();
    }
  }


  // ============================================================
  // HISTORIAL
  // ============================================================

  // Abrir modal
  openHistory() {
    console.group('%c[History] openHistory()', 'color:#64b5f6');
    this.showHistory = true;
    console.groupEnd();
  }

  closeHistory() {
    console.group('%c[History] closeHistory()', 'color:#ef5350');
    this.showHistory = false;
    console.groupEnd();
  }

  loadHistory(entry: HistoryEntry) {
    console.group('%c[History] loadHistory()', 'color:#81c784');
    console.log('→ Loading:', entry);

    const cards = Array.isArray(entry.cards) ? entry.cards : [];

    // reconstrucción del board
    this.placed = cards.map((c) => ({
      ...c,
      delay: 0,
      dealt: true,
      faceup: true,
      layer: 0,
    }));

    this.showHistory = false;
    console.groupEnd();
  }

  async deleteHistory(id: string, ev?: Event) {
    ev?.stopPropagation?.();

    console.group('%c[History] deleteHistory()', 'color:#ffcc80');
    this.historyList = this.historyList.filter((h) => h.id !== id);
    this.writeHistory(this.historyList);
    this.cdr.markForCheck();

    try {
      const firebaseUser = this.auth.currentUser;
      const token = firebaseUser
        ? await firebaseUser.getIdToken(true)
        : await this.authService.getIdToken();

      if (!token) {
        console.warn('⚠️ No token para borrar history');
        return;
      }

      await fetch(`${environment.API_BASE}/history/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.error('❌ Error borrando history remoto:', err);
    } finally {
      console.groupEnd();
    }
  }


  // =======================================================
  // RUN INTERPRETATION → llama al Worker + descuenta DRUCOINS
  // =======================================================

  async runInterpretation() {
    console.group('%c[Interpretation] runInterpretation()', 'color:#ff66ff');

    if (this.isInterpreting) {
      console.warn('⚠️ Ya interpretando. Ignorar.');
      console.groupEnd();
      return;
    }

    if (!(await this.ensureReadingAllowance())) {
      console.warn('❌ No permitido interpretar');
      console.groupEnd();
      return;
    }

    this.hideInterpretationModal();

    try {
      this.isInterpreting = true;
      this.setBodyModalState('interpreting', true);

      const cards = this.placed.map((c) => ({
        cardId: c.cardId,
        reversed: c.reversed,
      }));

      console.log('→ Cards enviadas al worker:', cards);
      console.log('→ Context:', this.userContext);

      const firebaseUser = this.auth.currentUser;
      const token = firebaseUser
        ? await firebaseUser.getIdToken(true)
        : await this.authService.getIdToken();

      if (!token) {
        console.error('❌ token null → login');
        await this.router.navigate(['/login']);
        console.groupEnd();
        return;
      }

      console.log('→ Consultando /interpret en worker…');

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

      console.log('→ Worker status:', res.status);

      if (res.status === 402) {
        const payload = await res.json().catch(() => ({}));
        console.error('❌ No tenía DruCoins suficientes:', payload);

        if (typeof payload?.drucoins === 'number') {
          this.authService.updateDrucoinBalance(payload.drucoins);
          this.sessionService.setDrucoins(payload.drucoins);
        }

        alert(payload?.message || 'No tienes DruCoins suficientes.');
        console.groupEnd();
        return;
      }

      const data = await res.json();
      console.log('→ Worker response JSON:', data);

      if (typeof data?.drucoins === 'number') {
        console.log('→ Actualizando DruCoins:', data.drucoins);
        this.authService.updateDrucoinBalance(data.drucoins);
        this.sessionService.setDrucoins(data.drucoins);
      }

      if (data.ok && data.interpretation) {
        console.log('✔ Interpretación recibida');
        const interpretation = this.normalizeInterpretation(data.interpretation);

        this.interpretationText = interpretation;
        this.interpretationSafe = this.sanitizer.bypassSecurityTrustHtml(
          this.toHtml(interpretation)
        );

        this.showInterpretation = true;
        this.setBodyModalState('interpret-view', true, 'interpret-open');
      } else {
        alert('No se recibió interpretación.');
        console.warn('⚠️ Interpretación vacía');
      }

    } catch (err) {
      console.error('❌ Error interpretando la tirada:', err);
      alert('Error interpretando la tirada.');
    } finally {
      this.isInterpreting = false;
      this.setBodyModalState('interpreting', false);
      this.cdr.markForCheck();
      console.groupEnd();
    }
  }




  // ============================================================
  // PARTE 4 — OVERLAYS / MODALES / PRIVACY / BG / VIEWPORT / SAVE READING, PROBANDO ALGO 
  // ============================================================


  // ------------------------------------------------------------
  // Observador responsive para móvil / desktop
  // ------------------------------------------------------------
  private observeViewport() {
    console.group('%c[Viewport] observeViewport()', 'color:#81d4fa');

    this.breakpointObserver
      .observe([this.viewportQuery])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        this.isMobile = state.matches;
        console.log('→ isMobile:', this.isMobile);
        this.cdr.markForCheck();
      });

    console.groupEnd();
  }


  // ------------------------------------------------------------
  // Resolver fondo del tablero
  // ------------------------------------------------------------
  private async resolveBgInBackground() {
    console.group('%c[Background] resolveBgInBackground()', 'color:#aed581');

    const list = this.bgCandidates;

    for (const url of list) {
      try {
        await this.loader.preloadAll([url], 15000, { ignoreErrors: true });

        this.boardBgUrl = `url(${url})`;
        console.log('✔ Fondo cargado:', url);
        break;
      } catch {
        console.warn('⚠️ Fallo cargando fondo:', url);
      }
    }

    console.groupEnd();
  }


  // ------------------------------------------------------------
  // Mostrar significado de carta (overlay)
  // ------------------------------------------------------------
  async openCardMeaning(pc: Placed) {
  console.group('%c[Card Meaning] openCardMeaning()', 'color:#ba68c8');

  console.log('→ Carta:', pc);

  // Abrir modal
  this.showCardOverlay = true;
  this.overlayCardTitle = this.deckMap.get(pc.cardId)?.name || pc.cardId;
  this.loadingCardMeaning = true;
  this.overlayCardMeaning = '';

  try {
    console.log('→ Llamando API /card-meaning');

    const res = await fetch(`${environment.API_BASE}/card-meaning`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        // AUTH AGREGADO 🔥 (antes no enviabas token → estaba mal)
        Authorization: `Bearer ${this.idToken}` 
      },
      body: JSON.stringify({
        name: pc.cardId,
        reversed: pc.reversed,
      }),
    });

    const data = await res.json();
    console.log('→ Meaning recibido:', data);

    // ============================
    // 🔥 1. LÍMITE ALCANZADO
    // ============================
    if (data.limitReached) {
      this.overlayCardMeaning = `
        <strong>Límite alcanzado</strong><br><br>
        Ya consultaste el máximo de significados gratuitos.<br>
        Para ver más cartas debes interpretar una tirada completa (gratis por día) 
        o mejorar tu plan.
      `;
      this.loadingCardMeaning = false;
      this.cdr.markForCheck();
      console.groupEnd();
      return;
    }

    // ============================
    // 🔥 2. SIGNIFICADO NORMAL
    // ============================
    if (data.ok && data.meaning) {
      this.overlayCardMeaning = data.meaning;
    } else {
      this.overlayCardMeaning = 'Sin descripción disponible.';
    }

  } catch (err) {
    console.error('❌ Error obteniendo significado', err);
    this.overlayCardMeaning = 'Error obteniendo significado.';
  }

  this.loadingCardMeaning = false;
  this.cdr.markForCheck();
  console.groupEnd();
}




  // ------------------------------------------------------------
  // Cerrar significado de carta
  // ------------------------------------------------------------
  closeCardOverlay() {
    console.group('%c[Card Meaning] closeCardOverlay()', 'color:#ef5350');

    this.showCardOverlay = false;

    console.groupEnd();
  }


  // ------------------------------------------------------------
  // Control del estado <body> para modales
  // ------------------------------------------------------------
  private setBodyModalState(context: string, active: boolean, extraClass?: string) {
    console.group('%c[Modal] setBodyModalState()', 'color:#ffcc80');
    console.log('→ context:', context, 'active:', active);

    if (active) {
      this.activeModalContexts.add(context);

      document.body.classList.add('modal-open');
      if (extraClass) {
        document.body.classList.add(extraClass);
      }
    } else {
      this.activeModalContexts.delete(context);

      if (this.activeModalContexts.size === 0) {
        document.body.classList.remove('modal-open');
        document.body.classList.remove('interpret-open');
      }
      if (extraClass) {
        document.body.classList.remove(extraClass);
      }
    }

    console.groupEnd();
  }


  // ------------------------------------------------------------
  // Ocultar modal de interpretación IA
  // ------------------------------------------------------------
  private hideInterpretationModal() {
    console.group('%c[Interpretation Modal] hideInterpretationModal()', 'color:#26a69a');

    this.showInterpretation = false;

    document.body.classList.remove('interpret-open');
    this.activeModalContexts.delete('interpret-view');

    if (this.activeModalContexts.size === 0) {
      document.body.classList.remove('modal-open');
    }

    console.groupEnd();
  }


  // ------------------------------------------------------------
  // Panel "Privacidad"
  // ------------------------------------------------------------
  openPrivacy() {
    console.group('%c[UI] openPrivacy()', 'color:#90caf9');

    alert('Aquí va tu página de privacidad (pendiente).');

    console.groupEnd();
  }


  // ------------------------------------------------------------
  // Layout principal según tipo de spread
  // ------------------------------------------------------------
  private buildLayout(id: string) {
    if (id === 'celtic-cross-10') return this.celticCross10();
    if (id === 'ppf-3') return this.ppf3();
    return this.free9();
  }

  // Layout → Cruz Celta (10)
  private celticCross10() {
    const Cx = 45, Cy = 50;
    const dx = 15, dy = 13;
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

  // Layout → Pasado / Presente / Futuro (3)
  private ppf3() {
    return [
      { position: 1, x: 35, y: 52, r: 0, z: 10 },
      { position: 2, x: 50, y: 52, r: 0, z: 11 },
      { position: 3, x: 65, y: 52, r: 0, z: 12 },
    ];
  }

  // Layout → Free (modo libre)
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


  // ------------------------------------------------------------
  // Drag & Drop
  // ------------------------------------------------------------
  onDragEnd(pc: Placed, ev: CdkDragEnd) {
    console.groupCollapsed('%c[DragEnd]', 'color:#80cbc4');

    const el = ev.source.getRootElement() as HTMLElement;
    const board = el.closest('.board') as HTMLElement;
    if (!board) {
      console.warn('⚠️ No board encontrado');
      console.groupEnd();
      return;
    }

    const rect = board.getBoundingClientRect();
    const cx = el.getBoundingClientRect().left + el.offsetWidth / 2;
    const cy = el.getBoundingClientRect().top + el.offsetHeight / 2;

    pc.x = ((cx - rect.left) / rect.width) * 100;
    pc.y = ((cy - rect.top) / rect.height) * 100;

    console.log(`→ Nueva posición: (${pc.x.toFixed(1)}%, ${pc.y.toFixed(1)}%)`);
    console.groupEnd();
  }

  onCardClick(pc: Placed, ev: MouseEvent) {
    ev.stopPropagation();

    pc.faceup = !pc.faceup;

    const maxZ = Math.max(...this.activeCards.map((p) => p.z));
    pc.z = maxZ + 1;

    console.log(`🃏 Flip card ${pc.cardId}, z → ${pc.z}`);
  }


  // ------------------------------------------------------------
  // Navegación entre cartas (modo móvil)
  // ------------------------------------------------------------
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


  // ------------------------------------------------------------
  // Click sobre el mazo
  // ------------------------------------------------------------
  onDeckClick() {
    console.group('%c[Deck Click]', 'color:#ffca28');

    if (!this.canDeal) {
      console.log('→ No puede repartir → activar shuffle animation');
      this.toggleShuffle();
      console.groupEnd();
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
      console.groupEnd();
      return;
    }

    if (this.isFree) {
      console.log('→ Modo libre: agregando 1 carta');
      this.agregarCartaLibre(1);
      console.groupEnd();
      return;
    }

    console.log('→ Tirada normal');
    this.hacerTirada();

    console.groupEnd();
  }


  // ------------------------------------------------------------
  // Reparto Cruz Celta paso a paso
  // ------------------------------------------------------------
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

    console.log('🧪 Preparando Cruz Celta por pasos…');

    const res: DrawResult = await firstValueFrom(
      this.api.draw('celtic-cross-10')
    );

    const mapped: Placed[] = res.cards.map((c, i) => {
      const p =
        this.slots[i] ?? {
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

    console.log(`🃏 Colocando carta #${pc.position}: ${pc.cardId}`);

    this.placed.push(pc);

    setTimeout(() => {
      pc.dealt = true;
      setTimeout(() => {
        pc.faceup = true;
        if (this.nextIdx >= this.buffer.length) {
          this.saveToHistory();
        }
      }, 350);
    });
  }


  // ------------------------------------------------------------
  // Modo Libre (free mode)
  // ------------------------------------------------------------
  agregarCartaLibre(n = 1) {
    if (!this.deckReady) return;

    console.group('%c[Free Mode] agregarCartaLibre()', 'color:#4dd0e1');

    const used = new Set<string>(
      this.layers.flatMap((l) => l.cards.map((c) => c.cardId))
    );

    const allIds = Array.from(this.deckMap.keys());
    const pool = allIds.filter((id) => !used.has(id));

    if (!pool.length) {
      console.warn('⚠️ No quedan cartas disponibles');
      console.groupEnd();
      return;
    }

    const target = this.layers[this.activeLayer];
    if (!target) {
      console.error('❌ activeLayer inválido');
      console.groupEnd();
      return;
    }

    const room = Math.max(0, 10 - target.cards.length);
    let toCurrent = Math.min(room, n);
    let remaining = n - toCurrent;

    // Añadir a la capa actual
    if (toCurrent > 0) {
      const cards = this.generateFreeCards(pool, toCurrent, this.activeLayer);
      target.cards.push(...cards);
      this.runDealAnimation(cards);
    }

    // Crear nuevas capas si no cabe
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

    console.groupEnd();
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
      .preloadAll([this.backUrl, ...urls], 60000, {
        ignoreErrors: true,
      })
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

      return {
        position: i + 1,
        x: Math.min(85, 30 + col * gx),
        y: Math.min(80, 30 + row * gy),
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

      return {
        position: i + 1,
        x: cx + R * Math.sin(rad),
        y: cy - R * Math.cos(rad),
        r,
      };
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

    console.log(`🌀 Creando nueva capa #${id}`);

    this.layers.push({ id, cards: [] });
    this.activeLayer = this.layers.length - 1;

    this.layerOverlay = true;
    setTimeout(() => (this.layerOverlay = false), 500);
  }

  switchLayer(i: number) {
    console.log('→ Cambiando a layer', i);

    if (i >= 0 && i < this.layers.length) {
      this.activeLayer = i;
    }
  }

  private runDealAnimation(cards: Placed[]) {
    setTimeout(() => {
      cards.forEach((pc, index) => {
        setTimeout(() => {
          pc.dealt = true;
          setTimeout(() => {
            pc.faceup = true;
          }, 300);
        }, index * 100);
      });

      this.saveToHistory();
    });
  }

  private saveToHistory() {
    try {
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        spreadId: this.spreadId,
        spreadLabel: this.spreadLabel,
        cards: JSON.parse(JSON.stringify(this.placed)),
        ts: Date.now()
      };

      // guardar local
      const list = this.readHistory();
      list.unshift(entry);
      this.writeHistory(list);

      // actualizar lista en memoria
      this.historyList = list;
    } catch (err) {
      console.error('[History] Error en saveToHistory()', err);
    }
  }



  // ------------------------------------------------------------
  //              Utils / FPS / TrackBy
  // ------------------------------------------------------------
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
      t
        .replace(/&/g, '&amp;')
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


  // ------------------------------------------------------------
  // Tracking helpers
  // ------------------------------------------------------------
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


  // ------------------------------------------------------------
  // Panel y menú colgante
  // ------------------------------------------------------------
  toggleBookPanel() {
    this.showBookPanel = !this.showBookPanel;
  }

  async openSavedReadings() {
    console.group('%c[SavedReadings] openSavedReadings()', 'color:#82b1ff');

    this.showSavedReadings = true;
    this.savedError = null;
    this.setBodyModalState('saved-readings', true);

    await this.loadSavedReadings();

    console.groupEnd();
  }

  closeSavedReadings() {
    console.group('%c[SavedReadings] closeSavedReadings()', 'color:#ef9a9a');

    this.showSavedReadings = false;
    this.setBodyModalState('saved-readings', false);
    this.closeSavedInterpretation();

    console.groupEnd();
  }

  private async loadSavedReadings() {
    console.group('%c[SavedReadings] loadSavedReadings()', 'color:#ffcc80');

    this.savedReadingsLoading = true;
    this.savedError = null;

    try {
      const firebaseUser = this.auth.currentUser;
      const token = firebaseUser
        ? await firebaseUser.getIdToken(true)
        : await this.authService.getIdToken();

      if (!token) {
        this.savedError = 'Inicia sesión para ver tus interpretaciones.';
        return;
      }

      const res = await fetch(`${environment.API_BASE}/readings/list`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        this.savedError = 'No se pudo cargar tu biblioteca.';
        return;
      }

      const data = await res.json();
      const rawItems = Array.isArray(data?.items) ? data.items : data?.readings;

      if (!Array.isArray(rawItems)) {
        this.savedReadings = [];
        return;
      }

      this.savedReadings = rawItems.map((item: any) => ({
        id: item.id,
        title: item.title || 'Lectura guardada',
        createdAt: Number(item.createdAt ?? item.created_at ?? Date.now()),
      }));
    } catch (err) {
      console.error('❌ loadSavedReadings error:', err);
      this.savedError = 'No se pudo cargar tu biblioteca.';
    } finally {
      this.savedReadingsLoading = false;
      this.cdr.markForCheck();
      console.groupEnd();
    }
  }

  async viewSavedReading(item: SavedReadingSummary, ev?: Event) {
    ev?.stopPropagation?.();

    console.group('%c[SavedReadings] viewSavedReading()', 'color:#8bc34a');
    console.log('→ item:', item);

    this.savedDetail = null;
    this.savedDetailSafe = null;
    this.savedDetailLoading = true;

    try {
      const firebaseUser = this.auth.currentUser;
      const token = firebaseUser
        ? await firebaseUser.getIdToken(true)
        : await this.authService.getIdToken();

      if (!token) {
        this.savedError = 'Inicia sesión nuevamente.';
        return;
      }

      const res = await fetch(`${environment.API_BASE}/readings/${item.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        this.savedError = 'No se pudo abrir la interpretación.';
        return;
      }

      const data = await res.json();
      if (!data?.ok) {
        this.savedError = 'Lectura no disponible.';
        return;
      }

      const interpretation = data.interpretation || '';
      this.savedDetail = {
        id: data.id,
        title: data.title || item.title,
        createdAt: Number(data.createdAt ?? Date.now()),
        interpretation,
        cards: data.cards ?? [],
        spreadId: data.spreadId,
      };
      this.savedDetailSafe = this.sanitizer.bypassSecurityTrustHtml(
        this.toHtml(interpretation)
      );

      this.setBodyModalState('history-modal-interpretation', true, 'interpret-open');
    } catch (err) {
      console.error('❌ viewSavedReading error:', err);
      this.savedError = 'No se pudo abrir la interpretación.';
    } finally {
      this.savedDetailLoading = false;
      this.cdr.markForCheck();
      console.groupEnd();
    }
  }

  closeSavedInterpretation() {
    if (!this.savedDetail && !this.savedDetailLoading) {
      return;
    }

    console.group('%c[SavedReadings] closeSavedInterpretation()', 'color:#ef5350');

    this.savedDetail = null;
    this.savedDetailSafe = null;
    this.savedDetailLoading = false;
    this.setBodyModalState('history-modal-interpretation', false, 'interpret-open');

    console.groupEnd();
  }

  openSubscription() {
    console.log('[Menu] openSubscription clicked');
  }

  openProfile() {
    console.log('[Menu] openProfile clicked');
  }

  toggleSettings() {
    console.log('[Menu] toggleSettings clicked');
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
      const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return this.normalizeHistoryList(stored);
    } catch {
      return [];
    }
  }

  private writeHistory(list: HistoryEntry[]) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {}
  }

  private normalizeHistoryList(source: any): HistoryEntry[] {
    if (!Array.isArray(source)) return [];
    return source
      .map((entry) => this.normalizeHistoryEntry(entry))
      .filter((entry): entry is HistoryEntry => !!entry);
  }

  private normalizeHistoryEntry(raw: any): HistoryEntry | null {
    if (!raw) return null;
    const safeId = typeof raw.id === 'string' ? raw.id : this.generateHistoryId();
    const cards = this.parseHistoryCards(raw.cards ?? raw.cards_json);

    return {
      id: safeId,
      spreadId: raw.spreadId || 'free',
      spreadLabel: raw.spreadLabel || 'Tirada',
      cards,
      ts: typeof raw.ts === 'number' ? raw.ts : Number(raw.ts) || Date.now(),
    };
  }

  private parseHistoryCards(value: any): Placed[] {
    if (Array.isArray(value)) {
      return value as Placed[];
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed as Placed[];
        }
      } catch {
        // ignore parse errors
      }
    }

    return [];
  }

  private generateHistoryId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `history-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  } // ← cierre final del componente
