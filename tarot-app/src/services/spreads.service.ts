import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';  // 👈 añadimos firstValueFrom
import { environment } from '../environments/environment'; // 👈 añadimos environment

export interface SpreadDef {
  id: string;
  name: string;
  positions?: Array<{ index: number; label: string; allowsReversed: boolean }>;
  slots?: number;
}

export interface CardMeta {
  id: string;
  name: string;
  suit: 'wands' | 'swords' | 'cups' | 'pents' | 'major';
  imageUrl: string;
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
  private base = ''; // mismo host del proxy: /api...

  // 🔹 Obtiene definiciones de spreads
  spreads(): Observable<SpreadDef[]> {
    return this.http.get<SpreadDef[]>(`${this.base}/api/spreads`);
  }

  // 🔹 Obtiene metadatos del mazo
  decks(): Observable<CardMeta[]> {
    return this.http.get<CardMeta[]>(`${this.base}/api/decks`);
  }

  // 🔹 Tirada simple (sin login)
  draw(spreadId: string): Observable<DrawResult> {
    return this.http.post<DrawResult>(`${this.base}/api/draw`, { spreadId });
  }

  // 🔹 Tirada autenticada con Firebase
  async drawWithAuth(spreadId: string, uid: string, token: string): Promise<DrawResult> {
    const body = { spreadId, allowsReversed: true, uid };

    return await firstValueFrom(
      this.http.post<DrawResult>(`${environment.API_BASE}/api/draw`, body, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        withCredentials: true
      })
    );
  }
}
