  import { Injectable, inject } from '@angular/core';
  import { HttpClient } from '@angular/common/http';
  import { Observable, firstValueFrom } from 'rxjs';
  import { environment } from '../environments/environment.prod';

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

  export interface HistoryItem {
    id: string;
    spreadId: string;
    spreadLabel: string;
    cards_json: string;
    ts: number;
  }

  @Injectable({ providedIn: 'root' })
  export class TarotApi {
    private http = inject(HttpClient);
    private base = environment.API_BASE; // ✅ apunta directamente al Worker (sin /api extra)

    // 🔹 Obtiene definiciones de spreads
    spreads(): Observable<SpreadDef[]> {
      return this.http.get<SpreadDef[]>(`${this.base}/spreads`);
    }

    // 🔹 Obtiene metadatos del mazo
    decks(): Observable<CardMeta[]> {
      return this.http.get<CardMeta[]>(`${this.base}/decks`);
    }

    // 🔹 Tirada simple (sin login)
    draw(spreadId: string): Observable<DrawResult> {
      return this.http.post<DrawResult>(`${this.base}/draw`, { spreadId });
    }

    loadHistory(id: string) {
      return this.http.get<DrawResult>(`${environment.API_BASE}/history/${id}`);
    }

   loadDeck() {
  return this.http.get<CardMeta[]>(`${this.base}/decks`);
  // this.base ya es environment.API_BASE
}

    deleteHistory(id: string) {
      return this.http.delete<{ ok: boolean }>(`${environment.API_BASE}/history/${id}`);
    }

    listHistory(uid: string) {
      return this.http.get<HistoryItem[]>(`${environment.API_BASE}/history?uid=${uid}`);
    }

    getSpreads() {
      return this.http.get<SpreadDef[]>(`${environment.API_BASE}/spreads`);
    }

    // 🔹 Tirada autenticada con Firebase
    async drawWithAuth(spreadId: string, uid: string, token: string): Promise<DrawResult> {
      const body = { spreadId, allowsReversed: true, uid };

      return await firstValueFrom(
        this.http.post<DrawResult>(`${this.base}/draw`, body, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          withCredentials: false // ✅ no hace falta credenciales cruzadas
        })
      );
    }
  }



