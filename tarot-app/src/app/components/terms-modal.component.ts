import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TermsCoordinatorService } from '../core/services/terms-coordinator.service';

@Component({
  selector: 'app-terms-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './terms-modal.component.html',
  styleUrls: ['./terms-modal.component.scss']
})
export class TermsModalComponent {

  checked = false;

  constructor(public terms: TermsCoordinatorService) {}

  accept() {
    if (!this.checked) return;
    this.terms.resolveAccept();
    this.checked = false;
  }

  close() {
    this.terms.resolveCancel();
    this.checked = false;
  }
}
