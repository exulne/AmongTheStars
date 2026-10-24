// Marks the places a data query matched, in whatever 3D view is showing.
// It needs nothing from the views but View.locate, so it works at every level:
// rings on worlds in a system, on stars nearby, a count where several share a spot.

import * as THREE from 'three';
import type { Ctx, View } from '../view/views.ts';

export class Highlight {
  private canvas: HTMLCanvasElement;
  private ids: number[] = [];
  private proj = new THREE.Vector3();
  private view: () => View;
  private ctx: Ctx;
  private scene: HTMLCanvasElement;

  constructor(scene: HTMLCanvasElement, view: () => View, ctx: Ctx) {
    this.scene = scene; this.view = view; this.ctx = ctx;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hl-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    scene.after(this.canvas);
    const loop = () => { this.draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  /** Bodies to mark, or null for none. */
  set(ids: Iterable<number> | null): void { this.ids = ids ? [...ids] : []; if (!this.ids.length) this.clear(); }

  private clear(): void { this.canvas.getContext('2d')!.clearRect(0, 0, this.canvas.width, this.canvas.height); }

  private draw(): void {
    if (!this.ids.length) return;
    const r = this.scene.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio, 2);
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const v = this.view(), cam = this.ctx.camera;
    // several matches at one spot (worlds of one star, seen from afar) share a ring
    const spots = new Map<string, { x: number; y: number; n: number }>();
    for (const id of this.ids.length > 4000 ? this.ids.slice(0, 4000) : this.ids) {
      const p = v.locate(this.ctx, { kind: 'body', id });
      if (!p) continue;
      this.proj.copy(p).project(cam);
      if (this.proj.z > 1 || Math.abs(this.proj.x) > 1.02 || Math.abs(this.proj.y) > 1.02) continue;
      const x = (this.proj.x * 0.5 + 0.5) * r.width, y = (-this.proj.y * 0.5 + 0.5) * r.height;
      const k = `${Math.round(x / 3)}:${Math.round(y / 3)}`;
      const s = spots.get(k);
      if (s) s.n++; else spots.set(k, { x, y, n: 1 });
    }
    g.strokeStyle = 'rgba(255, 196, 92, 0.95)';
    g.fillStyle = 'rgba(255, 196, 92, 0.95)';
    g.lineWidth = 1.2;
    g.font = '10px Georgia, serif';
    for (const s of spots.values()) {
      g.beginPath();
      g.arc(s.x, s.y, 9, 0, Math.PI * 2);
      g.stroke();
      if (s.n > 1) g.fillText(String(s.n), s.x + 11, s.y - 7);
    }
  }
}
