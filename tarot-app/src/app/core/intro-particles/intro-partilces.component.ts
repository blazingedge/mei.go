import { Component, ElementRef, Input, OnDestroy, OnInit, ViewChild, HostListener } from '@angular/core';
import { environment } from '../../../environments/environment';


type Leaf = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;      // rotación
  vr: number;     // velocidad de rotación
  size: number;
  alpha: number;
  imgIdx: number; // índice de hoja (0 o 1)
};

@Component({
  standalone: true,
  selector: 'app-intro-particles',
  template: `<canvas #canvas class="particles-canvas"></canvas>`,
  styles: [`
    :host { position: absolute; inset: 0; display: block; overflow: hidden; z-index: 10; }
    .particles-canvas { width: 100%; height: 100%; display: block; pointer-events: none; }
  `]
})
export class IntroParticlesComponent implements OnInit, OnDestroy {
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @Input() leafCount = 30;

  private ctx!: CanvasRenderingContext2D;
  private raf = 0;
  private leaves: Leaf[] = [];
  private imgs: HTMLImageElement[] = [];
  private width = 0;
  private height = 0;
  textProgress = 0; 
  private maxTextOpacity = 0.9;

  private vortexStrength = 0;     // 0 = sin remolino, 1 = remolino completo
  private vortexX = 0;
  private vortexY = 0;
  private revealText = false;
  private textOpacity = 0;

  private audioCtx?: AudioContext;
  private analyser?: AnalyserNode;
  private dataArray?: Uint8Array;
  private rafId?: number;

  ngOnInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d')!;
    this.resize();

    this.preloadImages([
      'assets/leaves/leaf1.webp',
      'assets/leaves/leaf2.webp'
    ]).then(() => {
      this.spawnInitial();
      this.loop();
    });
    this.vortexX = this.width / 2;
    this.vortexY = this.height / 2;

  }


  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
  }
  private playMeigoIntro() {
  const audio = new Audio(`${environment.CDN_BASE}/audio/Lobo-de-Luna-y-Sal.ogg`);
  audio.volume = 0.75;
  audio.play().catch(err => {
    console.warn("No se pudo reproducir intro:", err);
  });
}


  @HostListener('window:resize')
  resize() {
    const canvas = this.canvasRef.nativeElement;
    const dpr = window.devicePixelRatio || 1;
    this.width = canvas.clientWidth;
    this.height = canvas.clientHeight;
    canvas.width = Math.round(this.width * dpr);
    canvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private preloadImages(paths: string[]) {
    const promises = paths.map(p => new Promise<void>((res, rej) => {
      const i = new Image();
      i.src = p;
      i.onload = () => { this.imgs.push(i); res(); };
      i.onerror = rej;
    }));
    return Promise.all(promises);
  }

  private spawnInitial() {
    for (let i = 0; i < this.leafCount; i++) this.spawnLeaf(true);
  }

  private spawnLeaf(top = false) {
    const size = 8 + Math.random() * 18;
    const x = Math.random() * this.width;
    const y = top ? (Math.random() * -this.height * 0.5) : (Math.random() * this.height);
    const vx = (Math.random() * 0.4 - 0.2) * 0.6;
    const vy = 0.15 + Math.random() * 0.75;
    const r = Math.random() * Math.PI * 2;
    const vr = (Math.random() * 0.015 - 0.007);
    const alpha = 0.6 + Math.random() * 0.3;
    const imgIdx = Math.floor(Math.random() * this.imgs.length);

    this.leaves.push({ x, y, vx, vy, r, vr, size, alpha, imgIdx });
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.update();
    this.draw();
  }

  

  private update() {
  const t = performance.now() / 1000;
  const wind = Math.sin(t * 0.35) * 0.25;

  // 🔥 Activación del remolino tras 2.5s
  if (performance.now() > 2500) {
    this.vortexStrength = Math.min(1, this.vortexStrength + 0.003);

    if (this.vortexStrength > 0.5) {
      this.revealText = true;
    }
  }

  for (let i = this.leaves.length - 1; i >= 0; i--) {
    const L = this.leaves[i];

    // Movimiento normal
    L.vx += wind * 0.02 * (0.5 + Math.random() * 0.5);
    L.x += L.vx;
    L.y += L.vy;
    L.r += L.vr;

    // 🌪️ EFECTO REMOLINO
    if (this.vortexStrength > 0) {
      const dx = this.vortexX - L.x;
      const dy = this.vortexY - L.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      // Fuerza del remolino
      const force = (this.vortexStrength * 0.03) / dist;

      L.vx += dx * force;
      L.vy += dy * force;

      // Extra giro para dar dinamismo
      L.vr += (Math.random() - 0.5) * 0.01;

      // Si está muy cerca del centro, desvanecer hoja
      if (dist < 120) {
        L.alpha = Math.max(0, L.alpha - 0.02);
      }
    }

    // Fade natural cuando están más bajas
    if (L.y > this.height * 0.65) {
      L.alpha = Math.max(0, L.alpha - 0.008);
    }

    // Cuando mueren → reaparecer desde arriba
    if (
      L.y > this.height + 60 ||
      L.x < -50 ||
      L.x > this.width + 50 ||
      L.alpha <= 0.02
    ) {
      this.leaves.splice(i, 1);
      this.spawnLeaf(true);
    }
  }
}






private draw() {
  const ctx = this.ctx;
  ctx.clearRect(0, 0, this.width, this.height);

  // 🌿 Dibujar hojas
  for (const L of this.leaves) {
    ctx.save();
    ctx.globalAlpha = L.alpha;
    ctx.translate(L.x, L.y);
    ctx.rotate(L.r);
    const img = this.imgs[L.imgIdx];
    const s = L.size;
    ctx.drawImage(img, -s / 2, -s / 2, s, s);
    ctx.restore();
  }

  // ✨ REVELAR “EL MEIGO”
  if (this.revealText) {
    this.textOpacity = Math.min(1, this.textOpacity + 0.015);

    ctx.save();
    ctx.globalAlpha = this.textOpacity;

    ctx.font = '64px Cinzel, serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 230, 200, 1)';

    // Brillo mágico
    ctx.shadowColor = 'rgba(255, 200, 120, 0.45)';
    ctx.shadowBlur = 24;

    ctx.fillText('EL MEIGO', this.width / 2, this.height / 2 + 20);

    ctx.restore();
  }
}


}

