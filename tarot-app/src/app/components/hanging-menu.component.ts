import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';

export type HangingMenuItem = {
  label: string;
  action: string;
};

@Component({
  selector: 'app-hanging-menu',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './hanging-menu.component.html',
  styleUrls: ['./hanging-menu.component.scss'],
})
export class HangingMenuComponent {

  @Input() title = 'Menú';
  @Input() items: HangingMenuItem[] = [];

  // ✅ importante: el Output emite *string*, no Event
  @Output() action = new EventEmitter<string>();

  open = false;

  toggleOpen() {
    this.open = !this.open;
  }

  onContentClick(ev: MouseEvent) {
    // para que un click dentro del panel no cierre el menú
    ev.stopPropagation();
  }

  onItemClick(act: string, ev: MouseEvent) {
    ev.stopPropagation();
    this.action.emit(act);
    this.open = false;
  }

  onAction(ev: MouseEvent) {
    ev.stopPropagation();
  }
}
