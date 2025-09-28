import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface SpreadDef {
  id: string;
  name: string;
  positions?: Array<{ index: number; label: string; allowsReversed: boolean }>;
  slots?: number; // opcional si lo usas
}

export interface CardMeta {
  id: string;
  name: string;
  suit: 'wands' | 'swords' | 'cups' | 'pents' | 'major';
  imageUrl: string; // absoluta al mismo origen
}

export interface DrawCard {
  position: number;
  cardId: string;
  reversed: boolean;
}

export interface DrawResult {
  spreadId: string;
  seed?: string;
  cards: DrawCard[];
}

@Injectable({ providedIn: 'root' })
export class TarotApi {
  private http = inject(HttpClient);
  private base = ''; // en dev: mismo host del proxy: /api...

  spreads(): Observable<SpreadDef[]> {
    return this.http.get<SpreadDef[]>(`${this.base}/api/spreads`);
  }

  decks(): Observable<CardMeta[]> {
    return this.http.get<CardMeta[]>(`${this.base}/api/decks`);
  }

  draw(spreadId: string): Observable<DrawResult> {
    return this.http.post<DrawResult>(`${this.base}/api/draw`, { spreadId });
  }
}
