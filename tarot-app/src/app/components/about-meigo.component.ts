import {
  Component,
  Input,
  Output,
  EventEmitter,
  HostListener,
} from '@angular/core';
import { NgIf, NgClass, CommonModule } from '@angular/common';

@Component({
  standalone: true,
  selector: 'app-about-meigo',
  imports: [NgIf, NgClass, CommonModule],
  templateUrl: './about-meigo.component.html',
  styleUrls: ['./about-meigo.component.scss'],
})
export class AboutMeigoComponent {
  @Input() open = false;
  @Output() closed = new EventEmitter<void>();


  
  // Slider de imágenes (lobo + otra que añadas)
  images = [
    'https://pub-dd5dcc9095b64f479cded9e2d85818d9.r2.dev/assets/v1/about/lobo-meigo.png',     // pon aquí tu ruta real de la imagen del lobo
    'https://pub-dd5dcc9095b64f479cded9e2d85818d9.r2.dev/assets/v1/about/abuelas-meigo.webp',  // y aquí la de tu abuela / familia
  ];
  currentImageIndex = 0;

  // Bottom sheet con la historia
  storyOpen = false;

  // Para audio con tu voz (cuando lo tengas grabado)
  private audioPlayer?: HTMLAudioElement;
  isPlaying = false;

  get currentImage(): string {
    return this.images[this.currentImageIndex];
  }

  nextImage() {
    this.currentImageIndex = (this.currentImageIndex + 1) % this.images.length;
  }

  prevImage() {
    this.currentImageIndex =
      (this.currentImageIndex - 1 + this.images.length) % this.images.length;
  }

  toggleStory() {
    this.storyOpen = !this.storyOpen;
  }

  closeAll() {
    this.storyOpen = false;
    this.closed.emit();
  }

  // Click fuera del card principal → cerrar
  onOverlayClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.classList.contains('about-overlay')) {
      this.closeAll();
    }
  }

  // Esc → cerrar
  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.open) {
      this.closeAll();
    }
  }

  playVoice() {
    // Cuando tengas el audio, pon su ruta aquí:
    const AUDIO_PATH = 'assets/audio/about-meigo-voice.ogg';

    if (!this.audioPlayer) {
      this.audioPlayer = new Audio(AUDIO_PATH);
      this.audioPlayer.addEventListener('ended', () => {
        this.isPlaying = false;
      });
    }

    if (this.isPlaying) {
      this.audioPlayer?.pause();
      this.audioPlayer!.currentTime = 0;
      this.isPlaying = false;
      return;
    }

    this.audioPlayer
      ?.play()
      .then(() => {
        this.isPlaying = true;
      })
      .catch((err) => {
        console.error('Error reproduciendo audio:', err);
      });
  }
}
