import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  standalone: true,
  selector: 'app-hanging-menu',
  imports: [CommonModule],
  templateUrl: './hanging-menu.component.html',
  styleUrls: ['./hanging-menu.component.scss']
})
export class HangingMenuComponent {
  @Input() title = 'Menú';
  @Input() closeOnSelect = true;
  @Output() action = new EventEmitter<string>();

  open = false;

  toggle() {
    this.open = !this.open;
  }

  close() {
    this.open = false;
  }

  onContentClick(event: Event) {
    const target =
      (event.target as HTMLElement)?.closest('[data-action]') || null;

    if (target) {
      const value = target.getAttribute('data-action') ?? '';
      this.action.emit(value);
      if (this.closeOnSelect) this.close();
    }
  }
}
