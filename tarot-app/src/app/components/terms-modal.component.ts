import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-terms-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './terms-modal.component.html',
  styleUrls: ['./terms-modal.component.scss']
})
export class TermsModalComponent {
  @Input() visible = false;
  @Output() accepted = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  checked = false;

  confirm() {
    this.accepted.emit();
    this.checked = false;
  }

  close() {
    this.closed.emit();
    this.checked = false;
  }
}
