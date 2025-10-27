import { Component, ElementRef, Input, OnDestroy, OnInit, ViewChild, HostListener } from '@angular/core';

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

  ngOnInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d')!;
    this.resize();

    // Precarga tus hojas 🍂
    this.preloadImages([
      'assets/leaves/leaf1.webp',
      'assets/leaves/leaf2.webp'
    ]).then(() => {
      this.spawnInitial();
      this.loop();
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
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
    const size = 8 + Math.random() * 18; // tamaño variable
    const x = Math.random() * this.width;
    const y = top ? (Math.random() * -this.height * 0.5) : (Math.random() * this.height);
    const vx = (Math.random() * 0.6 - 0.3) * (0.6 + Math.random());
    const vy = 0.3 + Math.random() * 1.4;
    const r = Math.random() * Math.PI * 2;
    const vr = (Math.random() * 0.02 - 0.01);
    const alpha = 0.6 + Math.random() * 0.4;
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
    const wind = Math.sin(t * 0.6) * 0.4; // viento suave

    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const L = this.leaves[i];
      L.vx += wind * 0.02 * (0.5 + Math.random() * 0.5);
      L.x += L.vx;
      L.y += L.vy;
      L.r += L.vr;

      if (L.y > this.height + 40 || L.x < -50 || L.x > this.width + 50) {
        this.leaves.splice(i, 1);
        this.spawnLeaf(true);
      }
    }
  }

  private draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

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
  }
}
