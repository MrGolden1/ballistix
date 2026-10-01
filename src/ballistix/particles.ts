import * as THREE from 'three';

/** GPU point-sprite particle system with additive, soft-edged particles. */
export class Particles {
  readonly points: THREE.Points;
  private readonly cap: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private baseSize: Float32Array;
  private gravity: Float32Array;
  private drag: Float32Array;
  private head = 0;
  /** Live particles; when none are alive and nothing changed, update() does no work at all. */
  private active = 0;
  private dirty = false;
  private material: THREE.ShaderMaterial;
  private geom: THREE.BufferGeometry;

  constructor(capacity = 4000) {
    this.cap = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.baseSize = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.pos.fill(0, 0);
    for (let i = 0; i < capacity; i++) this.pos[i * 3 + 1] = -100;

    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geom.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        attribute vec3 color;
        varying float vAlpha;
        varying vec3 vColor;
        uniform float uScale;
        void main() {
          vAlpha = alpha;
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.0, size * uScale / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          a *= a;
          gl_FragColor = vec4(vColor, a * vAlpha);
        }
      `,
    });
    this.points = new THREE.Points(this.geom, this.material);
    this.points.frustumCulled = false;
  }

  /** Converts world-space point size to pixels for the current viewport. */
  setViewport(heightPx: number, fovDeg: number): void {
    this.material.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: THREE.Color, size: number, life: number, gravity = 0, drag = 0): void {
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    if (this.life[i] <= 0) this.active++;
    this.dirty = true;
    const p = i * 3;
    this.pos[p] = x;
    this.pos[p + 1] = y;
    this.pos[p + 2] = z;
    this.vel[p] = vx;
    this.vel[p + 1] = vy;
    this.vel[p + 2] = vz;
    this.col[p] = color.r;
    this.col[p + 1] = color.g;
    this.col[p + 2] = color.b;
    this.baseSize[i] = size;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    this.alpha[i] = 1;
  }

  /** Radial burst on the floor plane with some upward spray. */
  burst(x: number, z: number, color: THREE.Color, count: number, speed: number, size = 0.35, life = 0.7, up = 3): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.emit(x, 0.4, z, Math.cos(a) * s, Math.random() * up, Math.sin(a) * s, color, size * (0.6 + Math.random() * 0.8), life * (0.6 + Math.random() * 0.6), 9, 1.2);
    }
  }

  update(dt: number): void {
    if (this.active === 0 && !this.dirty) return;
    this.dirty = false;
    for (let i = 0; i < this.cap; i++) {
      const l = this.life[i];
      if (l <= 0) {
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0;
          this.pos[i * 3 + 1] = -100;
        }
        continue;
      }
      const nl = l - dt;
      this.life[i] = nl;
      if (nl <= 0) {
        this.active--;
        this.dirty = true; // upload once more so it disappears
      }
      const p = i * 3;
      const drag = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[p] *= drag;
      this.vel[p + 1] = this.vel[p + 1] * drag - this.gravity[i] * dt;
      this.vel[p + 2] *= drag;
      this.pos[p] += this.vel[p] * dt;
      this.pos[p + 1] += this.vel[p + 1] * dt;
      this.pos[p + 2] += this.vel[p + 2] * dt;
      if (this.pos[p + 1] < 0.05 && this.gravity[i] > 0) {
        this.pos[p + 1] = 0.05;
        this.vel[p + 1] *= -0.3;
      }
      const k = Math.max(0, nl / this.maxLife[i]);
      this.alpha[i] = k;
      this.size[i] = this.baseSize[i] * (0.4 + 0.6 * k);
    }
    for (const name of ['position', 'color', 'size', 'alpha']) {
      (this.geom.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
  }
}
