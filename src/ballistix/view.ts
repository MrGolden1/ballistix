import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  BALL_R,
  GOAL_HALF,
  H,
  PADDLE_INSET,
  PADDLE_R,
  PADDLE_SPEED,
  SEATS,
  SERVE_HOLD,
  SIDES,
  SMASH_BOOST,
  FX_SHIELD,
  WALL_R,
  PADDLE_CURVE,
  SMASH_REACH,
  CRATE_INFO,
  type CrateKind,
} from './config';
import type { Ball, Crate, PlayerState, Sim, SimEvent } from './sim';
import { Particles } from './particles';
import { drawBadge, itemIconURL } from './icons';

const FOV = 38;
const WALL_HEIGHT = 1.0;
const CHAR_OFFSET = 0.75; // how far behind the goal line the character stands
const CHAR_SCALE = 0.85;

// --- procedural textures ----------------------------------------------------------------

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function cssColor(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function floorTexture(): THREE.CanvasTexture {
  const N = 1024;
  const s = N / (2 * H);
  return canvasTexture(N, N, (g) => {
    g.fillStyle = '#26315f';
    g.fillRect(0, 0, N, N);
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 20; j++) {
        if ((i + j) % 2 === 0) {
          g.fillStyle = 'rgba(255,255,255,0.04)';
          g.fillRect(i * s, j * s, s, s);
        }
      }
    }
    const rg = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N * 0.72);
    rg.addColorStop(0, 'rgba(110,150,255,0.30)');
    rg.addColorStop(1, 'rgba(110,150,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, N, N);

    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 10;
    g.strokeRect(5, 5, N - 10, N - 10);
  });
}

function netTexture(color: number): THREE.CanvasTexture {
  return canvasTexture(256, 64, (g) => {
    g.fillStyle = cssColor(color, 0.18);
    g.fillRect(0, 0, 256, 64);
    g.strokeStyle = cssColor(color, 0.9);
    g.lineWidth = 3;
    for (let x = 0; x <= 256; x += 16) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, 64);
      g.stroke();
    }
    for (let y = 0; y <= 64; y += 16) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(256, y);
      g.stroke();
    }
  });
}

/** Crate face for an item: the item's colour and icon, so players know what they are aiming for. */
function itemTexture(kind: CrateKind): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#6d4216';
    g.fillRect(0, 0, 256, 256);
    drawBadge(g, kind, 20, 20, 216);
  });
}

/** Round badge shown above a player who holds an item (icon in the item's colour with a white rim). */
function badgeTexture(kind: CrateKind): THREE.CanvasTexture {
  return canvasTexture(128, 128, (g) => {
    g.fillStyle = 'rgba(8, 10, 30, 0.85)';
    g.beginPath();
    g.roundRect(2, 2, 124, 124, 26);
    g.fill();
    drawBadge(g, kind, 10, 10, 108);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 5;
    g.beginPath();
    g.roundRect(10, 10, 108, 108, 13);
    g.stroke();
  });
}

function ballTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 128, (g) => {
    g.fillStyle = '#f4f7ff';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#3a4a8a';
    for (let i = 0; i < 4; i++) g.fillRect(i * 64 + 22, 0, 20, 128);
    g.fillStyle = '#ff9f1c';
    g.fillRect(0, 54, 256, 20);
  });
}

function skyTexture(): THREE.CanvasTexture {
  return canvasTexture(8, 512, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 512);
    gr.addColorStop(0, '#070b24');
    gr.addColorStop(0.5, '#1b2a66');
    gr.addColorStop(0.85, '#5a3a9a');
    gr.addColorStop(1, '#a65aa8');
    g.fillStyle = gr;
    g.fillRect(0, 0, 8, 512);
  });
}

// --- scene objects -----------------------------------------------------------------------

interface SeatObj {
  seat: number;
  bar: THREE.Group;
  barMat: THREE.MeshStandardMaterial;
  cyl: THREE.Mesh;
  capA: THREE.Mesh;
  capB: THREE.Mesh;
  char: THREE.Group;
  lean: THREE.Group;
  barrier: Barrier;
  /** Translucent ice shell that wraps the paddle while its owner is frozen. */
  ice: THREE.Mesh;
  iceMat: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  stripMat: THREE.MeshStandardMaterial;
  bayMat: THREE.MeshStandardMaterial;
  light: THREE.PointLight;
  leanSign: number;
  squash: number;
  fall: number;
  flash: number;
  /** 1 right after pressing smash, decays to 0 over the swing. */
  swing: number;
  /** Draw the swing-reach arc on the next frame. */
  swingFx: boolean;
}

interface BallObj {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  scale: number;
  px: number;
  py: number;
}

interface CrateObj {
  mesh: THREE.Group;
  ring: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  ringMat: THREE.MeshBasicMaterial;
  born: number;
  kind: CrateKind;
}

/** The icon badge floating above a character while that player holds an item. */
interface ItemBadge {
  sprite: THREE.Sprite;
  kind: CrateKind | null;
  /** Hidden until the flying icon arrives. */
  delay: number;
  /** 1 when it appears, fades to 0 (a little pop). */
  pop: number;
}

/** A crate icon flying from where it was collected to the collector's badge. */
interface Flier {
  sprite: THREE.Sprite;
  from: THREE.Vector3;
  seat: number;
  t: number;
}

interface LifeTag {
  sprite: THREE.Sprite;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  shown: string;
  pulse: number;
}

interface Ring {
  mesh: THREE.Mesh;
  t: number;
  dur: number;
  max: number;
  opacity: number;
}

/** A scored ball keeps flying into the goal, slows in the net, then sinks and vanishes. */
interface Ghost {
  obj: BallObj;
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  vy: number;
  seat: number;
  sinking: number;
  t: number;
}

const tmpColor = new THREE.Color();
const TINT = new THREE.Color();
const ROLL_AXIS = new THREE.Vector3();
const PROJ = new THREE.Vector3();
const HEMI_BASE = 1.1;
const SUN_BASE = 2.6;

/** Darker copy of a colour: additive particles add up fast, so hit effects use dimmed colours. */
function dim(c: THREE.Color, k: number): THREE.Color {
  return c.multiplyScalar(k);
}

/**
 * The force field that closes a goal. One effect, two looks:
 *  - eliminated player: cold, crackling electric blue, permanent;
 *  - shield item: the owner's colour, steadier; a strip along the goal burns down with the remaining time
 *    and the field flickers in its last 1.5 seconds.
 */
interface Barrier {
  group: THREE.Group;
  mat: THREE.ShaderMaterial;
  bolts: THREE.Line[];
  /** Glowing emitter strip on the floor: keeps the field readable from any camera angle. */
  strip: THREE.MeshBasicMaterial;
  stripMesh: THREE.Mesh;
  /** 0..1 how far it has powered up. */
  on: number;
  /** Set on a ball hit, fades out quickly. */
  flash: number;
  /** True for the eliminated-player look. */
  electric: boolean;
  nextBolt: number;
}

const BOLT_POINTS = 18;
const FLY_TIME = 0.55;
const FLY_TO = new THREE.Vector3();
const SPARK_POS = new THREE.Vector3();

function makeBarrier(seat: number): Barrier {
  const group = new THREE.Group();
  const n = SIDES[seat].n;
  group.rotation.y = Math.atan2(-n.x, -n.y);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uOn: { value: 0 }, uFlash: { value: 0 }, uCalm: { value: 0 }, uColor: { value: new THREE.Color(0x3fa9ff) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uOn; uniform float uFlash; uniform float uCalm; uniform vec3 uColor;
      varying vec2 vUv;
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        float n = i.x + i.y * 57.0;
        return mix(mix(hash(n), hash(n + 1.0), f.x), mix(hash(n + 57.0), hash(n + 58.0), f.x), f.y);
      }
      void main() {
        float t = uTime;
        float fade = smoothstep(1.0, 0.25, vUv.y) * smoothstep(0.0, 0.04, vUv.y);
        float n1 = noise(vec2(vUv.x * 14.0 - t * 3.0, vUv.y * 5.0 + t * 4.0));
        float n2 = noise(vec2(vUv.x * 31.0 + t * 6.0, vUv.y * 9.0 - t * 7.0));
        float arc = smoothstep(0.07, 0.0, abs(sin(vUv.y * 9.0 + n1 * 6.0 + t * 6.0)));
        arc += 0.6 * smoothstep(0.05, 0.0, abs(sin(vUv.y * 15.0 - n2 * 5.0 - t * 9.0)));
        arc *= mix(1.0, 0.45, uCalm);
        float hum = mix(0.12 + 0.05 * sin(t * 40.0 + vUv.x * 25.0), 0.48 + 0.05 * sin(t * 8.0 + vUv.x * 10.0), uCalm);
        float a = ((hum + arc) * uOn + uFlash * 0.2) * fade;
        vec3 col = mix(uColor, vec3(1.0), clamp(arc * 0.5 + uFlash * 0.35 + uCalm * 0.3, 0.0, 1.0));
        gl_FragColor = vec4(col * a, a);
      }
    `,
  });
  const sheet = new THREE.Mesh(new THREE.PlaneGeometry(2 * GOAL_HALF, 1.5), mat);
  sheet.position.y = 0.75;
  group.add(sheet);
  const floorPanel = new THREE.Mesh(new THREE.PlaneGeometry(2 * GOAL_HALF, 1.5), mat);
  floorPanel.rotation.x = -Math.PI / 2; // its "up" runs into the arena
  floorPanel.position.set(0, 0.03, -0.75);
  group.add(floorPanel);
  const bolts: THREE.Line[] = [];
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOLT_POINTS * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xd8f3ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    group.add(line);
    bolts.push(line);
  }
  const strip = new THREE.MeshBasicMaterial({ color: 0x9fe2ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const stripMesh = new THREE.Mesh(new THREE.BoxGeometry(2 * GOAL_HALF, 0.06, 0.34), strip);
  stripMesh.position.set(0, 0.05, -0.4);
  group.add(stripMesh);
  group.visible = false;
  return { group, mat, bolts, strip, stripMesh, on: 0, flash: 0, electric: false, nextBolt: 0 };
}
const WHITE = new THREE.Color(0xffffff);
const WHITE_HOT = new THREE.Color(0xfff4d6);
const FIRE = new THREE.Color(0xff7a1a);
const FIRE_TRAIL = new THREE.Color(0xff9a2a);
const SPLIT_PINK = new THREE.Color(0xff6b9d);
const ICE = new THREE.Color(0x9bf6ff);

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 3, 160);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private particles = new Particles(5000);
  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private spot!: THREE.SpotLight;
  /** The match winner (the camera and lights focus on their side), or -1; `win` eases 0..1. */
  private winSeat = -1;
  private win = 0;
  private winPos = new THREE.Vector3();
  private seats: SeatObj[] = [];
  private balls = new Map<number, BallObj>();
  private crates = new Map<number, CrateObj>();
  private rings: Ring[] = [];
  private ghosts: Ghost[] = [];
  /** A big lives counter floating above every goal, in the goal's colour. */
  private lifeTags: LifeTag[] = [];
  private badges: ItemBadge[] = [];
  private fliers: Flier[] = [];
  private badgeTex = new Map<CrateKind, THREE.CanvasTexture>();
  /** Adaptive resolution: render scale and a smoothed frame time. */
  private quality = 1;
  private frameMs = 16;
  private lastFrame = performance.now();
  private slowFor = 0;
  private fastFor = 0;
  /** True when the screen is wide enough to put the player cards beside the goals. */
  wide = false;
  private ringGeo = new THREE.RingGeometry(0.9, 1.0, 64);
  private ballGeo = new THREE.SphereGeometry(BALL_R, 32, 20);
  private ballTex = ballTexture();
  private crateTex = new Map<CrateKind, THREE.CanvasTexture>();
  /** Curved paddle geometries, cached per seat and length. */
  private barGeos = new Map<string, THREE.BufferGeometry>();
  private rocks: THREE.Mesh[] = [];
  private width = 1;
  private height = 1;
  private time = 0;
  private trauma = 0;
  private cine = 1;
  /** Seat whose goal is at the bottom of the screen. */
  private viewSeat = 0;
  private cineTarget = 1;
  private fitDist = 40;
  private confetti = 0;
  private confettiSeat = 0;
  private serveRing: THREE.Mesh;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping; // tone mapping is applied by the OutputPass

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    const out = new OutputPass();
    this.composer.addPass(out);

    this.scene.background = skyTexture();
    this.buildLights();
    this.buildArena();
    this.buildBackdrop();
    for (let i = 0; i < 4; i++) this.seats.push(this.buildSeat(i));
    for (let i = 0; i < 4; i++) this.lifeTags.push(this.buildLifeTag(i));
    for (let i = 0; i < 4; i++) this.badges.push(this.buildBadge());
    this.scene.add(this.particles.points);

    this.serveRing = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.serveRing.rotation.x = -Math.PI / 2;
    this.serveRing.position.y = 0.05;
    this.serveRing.visible = false;
    this.scene.add(this.serveRing);

    this.resize();
    addEventListener('resize', () => this.resize());
    this.warmUp();
  }

  // --- construction -------------------------------------------------------------------

  private buildLights(): void {
    this.hemi = new THREE.HemisphereLight(0xc7d6ff, 0x1a1d38, HEMI_BASE);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff1dd, SUN_BASE);
    this.sun = sun;
    sun.position.set(-9, 20, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -17;
    sc.right = 17;
    sc.top = 17;
    sc.bottom = -17;
    sc.near = 5;
    sc.far = 60;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);
    // Winner spotlight. It lives in the scene from the start (intensity 0): adding or removing a light
    // later would make three.js recompile every material, which shows up as a stutter.
    this.spot = new THREE.SpotLight(0xffffff, 0, 45, 0.4, 0.8, 2);
    this.scene.add(this.spot, this.spot.target);
  }

  private buildArena(): void {
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    const floorTex = floorTexture();
    floorTex.anisotropy = aniso;

    // base slab under everything
    const slab = new THREE.Mesh(
      new RoundedBoxGeometry(2 * H + 9, 1.2, 2 * H + 9, 4, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x1a2142, roughness: 0.8, metalness: 0.1 }),
    );
    slab.position.y = -0.62;
    slab.receiveShadow = true;
    this.scene.add(slab);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * H, 2 * H),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.55, metalness: 0.15 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.01;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x46528f, roughness: 0.45, metalness: 0.2 });
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x56649f, roughness: 0.4, metalness: 0.25 });

    for (let i = 0; i < 4; i++) {
      const side = SIDES[i];
      const seat = SEATS[i];
      const horizontal = side.t.x !== 0;
      const trimMat = new THREE.MeshStandardMaterial({ color: seat.color, emissive: seat.color, emissiveIntensity: 1.4, roughness: 0.3 });

      for (const dir of [-1, 1]) {
        // Horizontal walls run to the very corner, vertical walls stop before it so the boxes never overlap.
        const end = horizontal ? H + WALL_R : H - WALL_R;
        const len = end - GOAL_HALF;
        const centre = (end + GOAL_HALF) / 2;
        const box = new THREE.Mesh(new RoundedBoxGeometry(horizontal ? len : 2 * WALL_R, WALL_HEIGHT, horizontal ? 2 * WALL_R : len, 3, 0.09), wallMat);
        box.position.set(side.w.x + side.t.x * centre * dir, WALL_HEIGHT / 2, side.w.y + side.t.y * centre * dir);
        box.castShadow = true;
        box.receiveShadow = true;
        this.scene.add(box);

        const trim = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? len - 0.2 : 0.14, 0.08, horizontal ? 0.14 : len - 0.2), trimMat);
        trim.position.set(box.position.x, WALL_HEIGHT + 0.03, box.position.z);
        this.scene.add(trim);

        // pillar at the goal edge
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(WALL_R + 0.03, WALL_R + 0.06, 1.5, 24), pillarMat);
        pillar.position.set(side.w.x + side.t.x * GOAL_HALF * dir, 0.75, side.w.y + side.t.y * GOAL_HALF * dir);
        pillar.castShadow = true;
        this.scene.add(pillar);
        const cap = new THREE.Mesh(new THREE.SphereGeometry(WALL_R + 0.04, 20, 12), trimMat);
        cap.position.set(pillar.position.x, 1.55, pillar.position.z);
        this.scene.add(cap);
      }

      // goal bay: recessed pad, glowing strip and a net wall
      const out = { x: -side.n.x, y: -side.n.y };
      const bayDepth = 3.2;
      const bayMat = new THREE.MeshStandardMaterial({ color: 0x0f1530, emissive: seat.color, emissiveIntensity: 0.18, roughness: 0.7 });
      const bay = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? 2 * GOAL_HALF + 0.6 : bayDepth, 0.2, horizontal ? bayDepth : 2 * GOAL_HALF + 0.6), bayMat);
      bay.position.set(side.w.x + out.x * (bayDepth / 2), -0.09, side.w.y + out.y * (bayDepth / 2));
      bay.receiveShadow = true;
      this.scene.add(bay);

      const stripMat = new THREE.MeshStandardMaterial({ color: seat.color, emissive: seat.color, emissiveIntensity: 1.2, roughness: 0.3 });
      const strip = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? 2 * GOAL_HALF : 0.22, 0.08, horizontal ? 0.22 : 2 * GOAL_HALF), stripMat);
      strip.position.set(side.w.x, 0.05, side.w.y);
      this.scene.add(strip);

      const netMat = new THREE.MeshStandardMaterial({
        map: netTexture(seat.color),
        color: 0xffffff,
        emissive: seat.color,
        emissiveIntensity: 0.35,
        roughness: 0.8,
        transparent: true,
        opacity: 0.95,
      });
      const back = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? 2 * GOAL_HALF + 0.6 : 0.3, 1.5, horizontal ? 0.3 : 2 * GOAL_HALF + 0.6), netMat);
      back.position.set(side.w.x + out.x * bayDepth, 0.75, side.w.y + out.y * bayDepth);
      back.castShadow = true;
      this.scene.add(back);

      // Lights the goal bay, not the playing field: short range, set back behind the goal line.
      const light = new THREE.PointLight(seat.color, 16, 8, 2);
      light.position.set(side.w.x + out.x * 2.4, 1.8, side.w.y + out.y * 2.4);
      this.scene.add(light);

      // electric force field that closes the goal of an eliminated player
      const barrier = makeBarrier(i);
      barrier.group.position.set(side.w.x, 0, side.w.y);
      this.scene.add(barrier.group);

      this.seatPlaceholders[i] = { bayMat, stripMat, light, barrier };
    }

    // corner pillars
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.5, 1.5, 24), new THREE.MeshStandardMaterial({ color: 0x3a447c, roughness: 0.4, metalness: 0.3 }));
        p.position.set(sx * H, 0.75, sz * H);
        p.castShadow = true;
        this.scene.add(p);
        const cap = new THREE.Mesh(
          new THREE.SphereGeometry(0.4, 20, 12),
          new THREE.MeshStandardMaterial({ color: 0xcfe0ff, emissive: 0x8fb4ff, emissiveIntensity: 1.1 }),
        );
        cap.position.set(sx * H, 1.55, sz * H);
        this.scene.add(cap);
      }
    }
  }

  private seatPlaceholders: Record<number, { bayMat: THREE.MeshStandardMaterial; stripMat: THREE.MeshStandardMaterial; light: THREE.PointLight; barrier: Barrier }> = {};

  private buildBackdrop(): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0x232a55, roughness: 0.9, flatShading: true });
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
      const r = 24 + Math.random() * 22;
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1 + Math.random() * 2.6, 0), mat);
      rock.position.set(Math.cos(a) * r, -3 - Math.random() * 14, Math.sin(a) * r);
      rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.scene.add(rock);
      this.rocks.push(rock);
    }
  }

  private buildSeat(i: number): SeatObj {
    const side = SIDES[i];
    const seat = SEATS[i];
    const ph = this.seatPlaceholders[i];

    // paddle bar (long axis = local X)
    const barMat = new THREE.MeshStandardMaterial({ color: seat.color, emissive: seat.color, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0.2 });
    const bar = new THREE.Group();
    const cyl = new THREE.Mesh(this.barGeometry(i, 1), barMat);
    const capGeo = new THREE.SphereGeometry(PADDLE_R, 20, 14);
    const capA = new THREE.Mesh(capGeo, barMat);
    const capB = new THREE.Mesh(capGeo, barMat);
    for (const m of [cyl, capA, capB]) m.castShadow = true;
    bar.add(cyl, capA, capB);
    const iceMat = new THREE.MeshStandardMaterial({ color: 0xcdf7ff, emissive: 0x4fc3ff, emissiveIntensity: 0.55, roughness: 0.12, transparent: true, opacity: 0, depthWrite: false });
    const ice = new THREE.Mesh(this.barGeometry(i, 1, PADDLE_R * 1.9), iceMat);
    ice.visible = false;
    bar.add(ice);
    bar.rotation.y = side.t.x !== 0 ? 0 : Math.PI / 2;
    this.scene.add(bar);

    // character
    const char = new THREE.Group();
    const lean = new THREE.Group();
    char.add(lean);
    const skin = new THREE.MeshStandardMaterial({ color: seat.color, roughness: 0.55, metalness: 0.05 });
    const light = new THREE.MeshStandardMaterial({ color: tmpColor.set(seat.color).lerp(new THREE.Color(0xffffff), 0.65).getHex(), roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a2e, roughness: 0.4 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
    const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.castShadow = true;
      lean.add(mesh);
      return mesh;
    };
    add(new THREE.CapsuleGeometry(0.4, 0.5, 8, 18), skin, 0, 0.7, 0);
    add(new THREE.SphereGeometry(0.3, 18, 12), light, 0, 0.62, 0.3, 1, 1.15, 0.55);
    add(new THREE.SphereGeometry(0.43, 24, 18), skin, 0, 1.55, 0);
    add(new THREE.SphereGeometry(0.15, 14, 10), white, -0.18, 1.62, 0.34);
    add(new THREE.SphereGeometry(0.15, 14, 10), white, 0.18, 1.62, 0.34);
    add(new THREE.SphereGeometry(0.075, 12, 8), dark, -0.18, 1.62, 0.47);
    add(new THREE.SphereGeometry(0.075, 12, 8), dark, 0.18, 1.62, 0.47);
    add(new THREE.SphereGeometry(0.1, 12, 8), dark, 0, 1.48, 0.44, 1.3, 0.9, 0.9);
    add(new THREE.SphereGeometry(0.16, 12, 8), light, 0, 1.43, 0.36, 1.5, 1, 1);
    add(new THREE.SphereGeometry(0.17, 12, 8), skin, -0.45, 0.75, 0.05, 0.7, 1.4, 0.8); // arms
    add(new THREE.SphereGeometry(0.17, 12, 8), skin, 0.45, 0.75, 0.05, 0.7, 1.4, 0.8);
    add(new THREE.SphereGeometry(0.18, 12, 8), dark, -0.2, 0.08, 0.1, 1.1, 0.6, 1.5); // feet
    add(new THREE.SphereGeometry(0.18, 12, 8), dark, 0.2, 0.08, 0.1, 1.1, 0.6, 1.5);
    switch (i) {
      case 0: // pointy ears
        add(new THREE.ConeGeometry(0.17, 0.42, 12), skin, -0.27, 1.98, 0, 1, 1, 0.8).rotation.z = 0.25;
        add(new THREE.ConeGeometry(0.17, 0.42, 12), skin, 0.27, 1.98, 0, 1, 1, 0.8).rotation.z = -0.25;
        break;
      case 1: // round ears
        add(new THREE.SphereGeometry(0.2, 14, 10), skin, -0.34, 1.9, 0, 1, 1, 0.6);
        add(new THREE.SphereGeometry(0.2, 14, 10), skin, 0.34, 1.9, 0, 1, 1, 0.6);
        break;
      case 2: // horns
        add(new THREE.ConeGeometry(0.1, 0.4, 10), dark, -0.25, 1.95, 0.05).rotation.z = 0.35;
        add(new THREE.ConeGeometry(0.1, 0.4, 10), dark, 0.25, 1.95, 0.05).rotation.z = -0.35;
        break;
      default: // antenna
        add(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 8), dark, 0, 2.15, 0);
        add(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: seat.color, emissiveIntensity: 2 }), 0, 2.38, 0);
    }
    char.rotation.y = Math.atan2(side.n.x, side.n.y);
    char.scale.setScalar(CHAR_SCALE);
    this.scene.add(char);

    // Lean direction relative to the character's local X axis.
    const th = char.rotation.y;
    const leanSign = Math.cos(th) * side.t.x - Math.sin(th) * side.t.y;

    return {
      seat: i,
      bar,
      barMat,
      cyl,
      capA,
      capB,
      char,
      lean,
      barrier: ph.barrier,
      ice,
      iceMat,
      skin,
      stripMat: ph.stripMat,
      bayMat: ph.bayMat,
      light: ph.light,
      leanSign,
      squash: 0,
      fall: 0,
      flash: 0,
      swing: 0,
      swingFx: false,
    };
  }

/** A curved tube (parabola, like the collision shape) along the bar's local X axis. */
  private barGeometry(seat: number, h: number, radius = PADDLE_R): THREE.BufferGeometry {
    const side = SIDES[seat];
    const rot = side.t.x !== 0 ? 0 : Math.PI / 2;
    // Which local Z direction points into the arena for this seat.
    const sign = side.n.x * Math.sin(rot) + side.n.y * Math.cos(rot) > 0 ? 1 : -1;
    const hq = Math.round(h * 20) / 20;
    const key = `${sign}:${hq}:${radius}`;
    let geo = this.barGeos.get(key);
    if (!geo) {
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-hq, 0, 0), new THREE.Vector3(0, 0, sign * 2 * PADDLE_CURVE), new THREE.Vector3(hq, 0, 0));
      geo = new THREE.TubeGeometry(curve, 24, radius, 14, false);
      this.barGeos.set(key, geo);
    }
    return geo;
  }

  // --- public API ---------------------------------------------------------------------

  private badgeTexture(kind: CrateKind): THREE.CanvasTexture {
    let t = this.badgeTex.get(kind);
    if (!t) {
      t = badgeTexture(kind);
      this.badgeTex.set(kind, t);
    }
    return t;
  }

  private buildBadge(): ItemBadge {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.scale.set(1.15, 1.15, 1);
    sprite.renderOrder = 7;
    sprite.visible = false;
    this.scene.add(sprite);
    return { sprite, kind: null, delay: 0, pop: 0 };
  }

  /** World position of a seat's badge: above the character, following the paddle. */
  private badgePos(seat: number, p: { s: number }, out: THREE.Vector3): THREE.Vector3 {
    const side = SIDES[seat];
    return out.set(side.w.x - side.n.x * CHAR_OFFSET + side.t.x * p.s, 3.4 + Math.sin(this.time * 3 + seat) * 0.08, side.w.y - side.n.y * CHAR_OFFSET + side.t.y * p.s);
  }

  private syncBadge(seat: number, p: { s: number; item: CrateKind | null; alive: boolean }, dt: number): void {
    const b = this.badges[seat];
    const kind = p.alive ? p.item : null;
    if (kind !== b.kind) {
      b.kind = kind;
      if (kind) {
        (b.sprite.material as THREE.SpriteMaterial).map = this.badgeTexture(kind);
        (b.sprite.material as THREE.SpriteMaterial).needsUpdate = true;
        b.pop = 1;
      }
    }
    b.delay = Math.max(0, b.delay - dt);
    b.pop = Math.max(0, b.pop - dt * 2.5);
    b.sprite.visible = !!kind && b.delay <= 0;
    if (!b.sprite.visible) return;
    this.badgePos(seat, p, b.sprite.position);
    const k = 1.15 * (1 + Math.sin(b.pop * Math.PI) * 0.4);
    b.sprite.scale.set(k, k, 1);
  }

  private startFlier(ev: Extract<SimEvent, { t: 'pickup' }>): void {
    if (ev.kind === 'life') return;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.badgeTexture(ev.kind), transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.scale.set(1.3, 1.3, 1);
    sprite.renderOrder = 8;
    this.scene.add(sprite);
    this.fliers.push({ sprite, from: new THREE.Vector3(ev.x, 1.0, ev.y), seat: ev.seat, t: 0 });
    this.badges[ev.seat].delay = FLY_TIME; // the badge appears when the icon arrives
  }

  private updateFliers(sim: Sim, dt: number): void {
    for (let i = this.fliers.length - 1; i >= 0; i--) {
      const f = this.fliers[i];
      f.t += dt;
      const k = Math.min(1, f.t / FLY_TIME);
      const e = k * k * (3 - 2 * k);
      const to = this.badgePos(f.seat, sim.players[f.seat] ?? { s: 0 }, FLY_TO);
      f.sprite.position.set(f.from.x + (to.x - f.from.x) * e, f.from.y + (to.y - f.from.y) * e + Math.sin(k * Math.PI) * 1.6, f.from.z + (to.z - f.from.z) * e);
      const sc = 1.3 - 0.15 * e;
      f.sprite.scale.set(sc, sc, 1);
      if (k >= 1) {
        this.scene.remove(f.sprite);
        f.sprite.material.dispose();
        this.fliers.splice(i, 1);
      }
    }
  }

  private buildLifeTag(seat: number): LifeTag {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    const side = SIDES[seat];
    sprite.position.set(side.w.x - side.n.x * 3.4, 2.5, side.w.y - side.n.y * 3.4);
    sprite.scale.set(2.6, 1.3, 1);
    sprite.renderOrder = 5;
    this.scene.add(sprite);
    return { sprite, ctx, tex, shown: '', pulse: 0 };
  }

  private drawLifeTag(seat: number, text: string, alive: boolean): void {
    const t = this.lifeTags[seat];
    const g = t.ctx;
    g.clearRect(0, 0, 256, 128);
    g.font = '900 92px "Trebuchet MS", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 14;
    g.strokeStyle = 'rgba(8, 10, 30, 0.85)';
    const label = alive ? `♥${text}` : '';
    g.strokeText(label, 128, 68);
    g.fillStyle = alive ? SEATS[seat].css : '#7d849e';
    g.fillText(label, 128, 68);
    t.tex.needsUpdate = true;
  }

  private syncLifeTag(seat: number, lives: number, alive: boolean, dt: number): void {
    const t = this.lifeTags[seat];
    const key = alive ? String(lives) : 'out';
    if (key !== t.shown) {
      if (t.shown !== '') t.pulse = 1; // a goal (or a life back): make it jump
      t.shown = key;
      this.drawLifeTag(seat, String(lives), alive);
    }
    t.pulse = Math.max(0, t.pulse - dt * 2.5);
    const k = 1 + Math.sin(t.pulse * Math.PI) * 0.35;
    t.sprite.scale.set(2.6 * k, 1.3 * k, 1);
    t.sprite.visible = alive;
  }

  /** Screen position just above a seat's goal (for pop-up labels). */
  goalLabelPos(seat: number): { x: number; y: number } {
    const side = SIDES[seat];
    return this.project(side.w.x - side.n.x * 1.2, 1.6, side.w.y - side.n.y * 1.2);
  }

  /**
   * Builds everything that can appear mid-match once, up front: three.js compiles a shader the first time
   * an object is drawn, which is a visible hitch if it happens during a goal or an elimination.
   */
  private warmUp(): void {
    const hidden: THREE.Object3D[] = [];
    const show = (o: THREE.Object3D) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    };
    for (const s of this.seats) {
      show(s.barrier.group);
      show(s.ice);
    }
    for (const b of this.badges) show(b.sprite);
    show(this.serveRing);
    const kinds = Object.keys(CRATE_INFO) as CrateKind[];
    for (const k of kinds) {
      this.renderer.initTexture(this.badgeTexture(k));
      if (!this.crateTex.has(k)) this.crateTex.set(k, itemTexture(k));
      this.renderer.initTexture(this.crateTex.get(k)!);
      itemIconURL(k);
    }
    // A ball and a crate in the scene, so their material variants compile too.
    const ballMat = new THREE.MeshStandardMaterial({ map: this.ballTex, color: 0xe6eaf5, roughness: 0.45, metalness: 0.35, emissive: 0xffffff, emissiveIntensity: 0.12 });
    const ball = new THREE.Mesh(this.ballGeo, ballMat);
    ball.castShadow = true;
    const crateMat = new THREE.MeshStandardMaterial({ map: this.crateTex.get('shield'), roughness: 0.55, emissive: 0xffffff, emissiveIntensity: 0.25 });
    const crate = new THREE.Mesh(new RoundedBoxGeometry(1.1, 1.1, 1.1, 2, 0.08), crateMat);
    crate.castShadow = true;
    this.scene.add(ball, crate);
    // The game draws into the composer's buffer (linear colour space), not the screen: compiling for the
    // screen would build shaders that are never used. Compile into the same kind of target.
    this.renderer.setRenderTarget(this.composer.renderTarget1);
    try {
      this.renderer.compile(this.scene, this.camera);
    } finally {
      this.renderer.setRenderTarget(null);
      this.scene.remove(ball, crate);
      ballMat.dispose();
      crateMat.dispose();
      crate.geometry.dispose();
      for (const o of hidden) o.visible = false;
    }
  }

  /** Rotates the camera so this seat's goal is at the bottom of the screen. */
  setViewSeat(seat: number): void {
    this.viewSeat = seat;
  }

  setCinematic(on: boolean): void {
    this.cineTarget = on ? 1 : 0;
  }

  /** Clears transient effects when a new match starts. */
  reset(): void {
    for (const s of this.seats) {
      s.squash = 0;
      s.fall = 0;
      s.flash = 0;
      s.swing = 0;
      s.barrier.on = 0;
      s.barrier.flash = 0;
      s.barrier.group.visible = false;
    }
    for (const id of [...this.balls.keys()]) this.removeBall(id);
    for (const id of [...this.crates.keys()]) this.removeCrate(id);
    for (const g of this.ghosts) {
      this.scene.remove(g.obj.mesh);
      g.obj.mat.dispose();
    }
    this.ghosts = [];
    for (const t of this.lifeTags) t.shown = '';
    for (const b of this.badges) {
      b.kind = null;
      b.sprite.visible = false;
      b.delay = 0;
    }
    for (const f of this.fliers) {
      this.scene.remove(f.sprite);
      f.sprite.material.dispose();
    }
    this.fliers = [];
    this.confetti = 0;
    this.trauma = 0;
    this.winSeat = -1;
    this.win = 0;
    this.applyWinLights();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.width = w;
    this.height = h;
    const dpr = Math.max(0.75, Math.min(window.devicePixelRatio, 2) * this.quality);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.particles.setViewport(h * dpr, FOV);
    // Fit the whole arena (plus goal bays) inside the viewport with room for the HUD.
    const aspect = w / h;
    const need = 2 * (H + 4.2);
    const elev = (58 * Math.PI) / 180;
    // Wide screens: the cards sit beside the goals, so the arena can fill the height.
    this.wide = aspect >= 1.45;
    const vNeed = this.wide ? need * Math.sin(elev) * 1.1 + 0.8 : need * Math.sin(elev) * 1.22 + 3;
    const hNeed = need * 1.12;
    const k = 2 * Math.tan((FOV * Math.PI) / 360);
    this.fitDist = Math.max(vNeed / k, hNeed / aspect / k);
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Match over: the camera and lights focus on the winner's side and confetti falls around them. */
  celebrate(seat: number): void {
    this.confetti = 8;
    this.confettiSeat = Math.max(0, seat);
    this.winSeat = seat;
  }

  // --- events -------------------------------------------------------------------------

  private seatColor(seat: number): THREE.Color {
    return tmpColor.set(SEATS[seat].color).clone();
  }

  private addRing(x: number, z: number, color: number, max: number, dur: number, opacity = 0.8): void {
    const mesh = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.06, z);
    mesh.scale.setScalar(0.1);
    this.scene.add(mesh);
    this.rings.push({ mesh, t: 0, dur, max, opacity });
  }

  handleEvent(ev: SimEvent): void {
    switch (ev.t) {
      case 'paddle': {
        const s = this.seats[ev.seat];
        s.squash = 1;
        s.flash = Math.max(s.flash, 0.25);
        this.particles.burst(ev.x, ev.y, dim(this.seatColor(ev.seat), 0.45), 4, 3 + ev.speed * 0.1, 0.18, 0.25, 1);
        break;
      }
      case 'wall':
        if (ev.closed) {
          const bar = this.seats[ev.seat].barrier;
          if (bar.on > 0.5) {
            // A ball hits the force field: a soft pulse and a few sparks (kept gentle on purpose).
            bar.flash = 0.55;
            const col = bar.electric ? new THREE.Color(0x9fe2ff) : this.seatColor(ev.seat);
            this.particles.burst(ev.x, ev.y, dim(col, 0.4), 7, 4, 0.2, 0.28, 1);
          }
        } else if (ev.speed > 3) {
          this.particles.burst(ev.x, ev.y, new THREE.Color(0x9bb8ff), 4, 3, 0.22, 0.3, 1);
        }
        break;
      case 'ballHit':
        this.particles.burst(ev.x, ev.y, dim(new THREE.Color(0xffffff), 0.35), 5, 3, 0.18, 0.25, 1);
        break;
      case 'goal': {
        const s = this.seats[ev.seat];
        s.flash = 0.8;
        this.particles.burst(ev.x, ev.y, dim(this.seatColor(ev.seat), 0.6), 26, 7, 0.32, 0.7, 3);
        this.addRing(ev.x, ev.y, SEATS[ev.seat].color, 4.5, 0.6, 0.45);
        this.shake(0.3);
        this.startGhost(ev);
        break;
      }
      case 'eliminated': {
        // Kept light on purpose: a big burst here caused a visible hitch.
        const side = SIDES[ev.seat];
        this.particles.burst(side.w.x + side.n.x * 0.6, side.w.y + side.n.y * 0.6, dim(this.seatColor(ev.seat), 0.55), 36, 9, 0.45, 1.0, 5);
        this.addRing(side.w.x, side.w.y, SEATS[ev.seat].color, 7, 0.8, 0.5);
        this.shake(0.35);
        break;
      }
      case 'crateSpawn': {
        const col = CRATE_INFO[ev.kind].color;
        this.particles.burst(ev.x, ev.y, new THREE.Color(col), 24, 5, 0.35, 0.8, 4);
        this.addRing(ev.x, ev.y, col, 2.5, 0.5);
        break;
      }
      case 'smash': {
        // Readable but gentle: a few warm sparks and a faint ring, no white flash.
        this.particles.burst(ev.x, ev.y, dim(new THREE.Color(0xff8a1f), 0.55), 12, 7, 0.28, 0.4, 2);
        this.addRing(ev.x, ev.y, 0xffa33d, 3, 0.4, 0.35);
        this.seats[ev.seat].flash = 0.4;
        this.shake(0.08);
        break;
      }
      case 'swing':
        this.seats[ev.seat].swing = 1;
        this.seats[ev.seat].swingFx = true;
        break;
      case 'split':
        this.particles.burst(ev.x, ev.y, new THREE.Color(0xff6b9d), 40, 9, 0.45, 0.6, 3);
        this.addRing(ev.x, ev.y, 0xff6b9d, 3.5, 0.45);
        break;
      case 'item': {
        const side = SIDES[ev.seat];
        const col = CRATE_INFO[ev.kind].color;
        this.addRing(side.w.x + side.n.x * PADDLE_INSET, side.w.y + side.n.y * PADDLE_INSET, col, 4, 0.5);
        this.particles.burst(side.w.x + side.n.x * 1.5, side.w.y + side.n.y * 1.5, new THREE.Color(col), 30, 6, 0.4, 0.7, 4);
        if (ev.kind === 'freeze') {
          // A freeze wave reaches every other paddle: a ring and a puff of frost on each.
          for (let s = 0; s < 4; s++) {
            if (s === ev.seat) continue;
            const o = SIDES[s];
            const x = o.w.x + o.n.x * PADDLE_INSET;
            const z = o.w.y + o.n.y * PADDLE_INSET;
            this.addRing(x, z, 0x9bf6ff, 6, 0.7, 0.55);
            this.particles.burst(x, z, new THREE.Color(0x9bf6ff).multiplyScalar(0.5), 16, 4, 0.35, 0.8, 2);
          }
        }
        break;
      }
      case 'lastStand': {
        const side = SIDES[ev.seat];
        this.addRing(side.w.x + side.n.x, side.w.y + side.n.y, 0xff3355, 7, 0.9);
        this.particles.burst(side.w.x + side.n.x * 1.2, side.w.y + side.n.y * 1.2, new THREE.Color(0xff3355), 50, 8, 0.45, 1.0, 4);
        this.shake(0.3);
        break;
      }
      case 'pickup': {
        this.startFlier(ev);
        const gold = new THREE.Color(CRATE_INFO[ev.kind].color);
        this.particles.burst(ev.x, ev.y, new THREE.Color(0xc98a3d), 30, 8, 0.4, 0.9, 6);
        this.particles.burst(ev.x, ev.y, gold, 40, 9, 0.35, 1.0, 6);
        this.addRing(ev.x, ev.y, SEATS[ev.seat].color, 5, 0.6);
        this.shake(0.12);
        break;
      }
      case 'crateExpire':
        this.particles.burst(ev.x, ev.y, new THREE.Color(0x888888), 12, 3, 0.3, 0.6, 2);
        break;
      case 'ballFade':
        this.particles.burst(ev.x, ev.y, new THREE.Color(0xff6b9d), 18, 4, 0.3, 0.6, 2);
        break;
      case 'serve':
      case 'countdown':
      case 'go':
      case 'win':
        break;
    }
  }

  // --- per-frame update ---------------------------------------------------------------

  private ballTint(b: Ball): THREE.Color {
    if (b.extra) return tmpColor.set(0xff6b9d);
    if (b.owner >= 0) return tmpColor.set(SEATS[b.owner].color);
    return tmpColor.set(0xffffff);
  }

  private removeBall(id: number): void {
    const o = this.balls.get(id);
    if (!o) return;
    this.scene.remove(o.mesh);
    o.mat.dispose();
    this.balls.delete(id);
  }

  private removeCrate(id: number): void {
    const o = this.crates.get(id);
    if (!o) return;
    this.scene.remove(o.mesh);
    this.scene.remove(o.ring);
    this.crates.delete(id);
  }

  update(sim: Sim, dt: number): void {
    this.time += dt;
    this.syncSeats(sim, dt);
    this.syncBalls(sim, dt);
    this.syncCrates(sim, dt);
    this.updateRings(dt);
    this.updateGhosts(dt);
    this.updateFliers(sim, dt);
    this.updateWin(dt);
    this.updateCamera(dt);
    this.adaptQuality();

    for (const r of this.rocks) {
      r.rotation.x += dt * 0.05;
      r.rotation.y += dt * 0.07;
    }

    if (this.confetti > 0) {
      this.confetti -= dt;
      const palette = [SEATS[this.confettiSeat].color, 0xffd23f, 0xffffff];
      // Confetti falls around the winner, not over the whole arena.
      const cx = this.winSeat >= 0 ? this.winPos.x : 0;
      const cz = this.winSeat >= 0 ? this.winPos.z : 0;
      for (let i = 0; i < 4; i++) {
        tmpColor.set(palette[Math.floor(Math.random() * palette.length)]).multiplyScalar(0.7);
        this.particles.emit(cx + (Math.random() - 0.5) * 12, 10 + Math.random() * 3, cz + (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 2, -3 - Math.random() * 3, (Math.random() - 0.5) * 2, tmpColor, 0.45, 2.6, 0.8, 0.2);
      }
    }
    this.particles.update(dt);
    this.composer.render(dt);
  }

  /** Renders without a simulation (used before the first match starts). */
  private syncSeats(sim: Sim, dt: number): void {
    for (const p of sim.players) {
      const o = this.seats[p.seat];
      const side = SIDES[p.seat];
      o.squash = Math.max(0, o.squash - dt * 4);
      o.flash = Math.max(0, o.flash - dt * 3);
      o.swing = Math.max(0, o.swing - dt * 5);

      // paddle bar
      const cx = side.w.x + side.n.x * PADDLE_INSET + side.t.x * p.s;
      const cz = side.w.y + side.n.y * PADDLE_INSET + side.t.y * p.s;
      const lunge = Math.sin(o.swing * Math.PI) * 0.45; // the bar jabs forward on a swing
      o.bar.position.set(cx + side.n.x * lunge, 0.45, cz + side.n.y * lunge);
      const geo = this.barGeometry(p.seat, p.h);
      if (o.cyl.geometry !== geo) o.cyl.geometry = geo;
      o.capA.position.x = -p.h;
      o.capB.position.x = p.h;
      o.bar.visible = p.alive;
      const chilled = p.fx.chill > 0;
      const big = p.fx.big > 0;
      const lastStand = sim.isLastStand(p);
      o.barMat.emissiveIntensity = 0.5 + o.flash * 0.2 + (big ? 0.35 + 0.2 * Math.sin(this.time * 8) : 0) + (lastStand ? 0.3 + 0.3 * Math.sin(this.time * 10) : 0);
      o.barMat.color.set(SEATS[p.seat].color);
      o.barMat.emissive.set(SEATS[p.seat].color);
      if (chilled) {
        o.barMat.color.lerp(ICE, 0.75);
        o.barMat.emissive.lerp(ICE, 0.75);
      }
      if (p.smashT > 0) {
        // The smash window is open: the paddle burns white-hot so the timing is readable.
        o.barMat.emissive.lerp(WHITE_HOT, 0.45);
        o.barMat.emissiveIntensity = 1.15;
      }
      if (p.fx.split > 0) {
        o.barMat.emissive.lerp(SPLIT_PINK, 0.55 + 0.25 * Math.sin(this.time * 9));
        o.barMat.emissiveIntensity = Math.max(o.barMat.emissiveIntensity, 1.3);
      }
      if (p.alive && Math.abs(p.axis) < 0.05 && Math.abs(p.vs) > 5 && Math.random() < 0.7) {
        // Drifting: dust kicks up under the character's feet.
        tmpColor.set(0x8890b8);
        const fx = side.w.x - side.n.x * CHAR_OFFSET + side.t.x * p.s;
        const fz = side.w.y - side.n.y * CHAR_OFFSET + side.t.y * p.s;
        this.particles.emit(fx, 0.15, fz, -side.t.x * Math.sign(p.vs) * 2 + (Math.random() - 0.5), 0.6 + Math.random(), -side.t.y * Math.sign(p.vs) * 2 + (Math.random() - 0.5), tmpColor, 0.35, 0.45, 2, 2);
      }
      if (o.swingFx) {
        // Show how far the swing reaches.
        o.swingFx = false;
        tmpColor.set(0x8a7c58);
        for (let k = 0; k < 18; k++) {
          const u = (k / 17) * 2 - 1;
          const along = u * (p.h + 0.5);
          const reach = SMASH_REACH * (0.75 + 0.25 * (1 - u * u));
          this.particles.emit(cx + side.t.x * along + side.n.x * reach, 0.35, cz + side.t.y * along + side.n.y * reach, side.n.x * 2, 0.3, side.n.y * 2, tmpColor, 0.3, 0.22, 0, 4);
        }
      }

      // character
      if (!p.alive) o.fall = Math.min(1, o.fall + dt * 1.4);
      const cxp = side.w.x - side.n.x * CHAR_OFFSET + side.t.x * p.s;
      const czp = side.w.y - side.n.y * CHAR_OFFSET + side.t.y * p.s;
      const bob = Math.sin(this.time * 3 + p.seat) * 0.03;
      o.char.position.set(cxp, bob - o.fall * 0.7, czp);
      const squash = Math.sin(o.squash * Math.PI) * 0.16;
      o.lean.scale.set(1 + squash * 0.5, 1 - squash, 1 + squash * 0.5);
      o.lean.rotation.z = -o.leanSign * clamp01(p.vs / PADDLE_SPEED, -1, 1) * 0.28;
      o.lean.rotation.x = -o.fall * 1.5 + Math.sin(o.swing * Math.PI) * 0.4;
      o.lean.position.z = Math.sin(o.swing * Math.PI) * 0.5;
      o.char.visible = o.fall < 0.98;
      if (p.alive && p.fx.chill > 0) {
        // Shivering: a fast, tiny sideways tremble.
        const tr = Math.sin(this.time * 60) * 0.035;
        o.char.position.x += side.t.x * tr;
        o.char.position.z += side.t.y * tr;
      }
      const winner = this.winSeat === p.seat;
      if (winner) {
        // The winner hops and sways.
        o.char.position.y += Math.abs(Math.sin(this.time * 4.5)) * 0.55 * this.win;
        o.lean.rotation.z += Math.sin(this.time * 3) * 0.12 * this.win;
        this.winPos.copy(o.char.position);
      }
      o.char.scale.setScalar(CHAR_SCALE * (winner ? 1 + 0.25 * this.win : 1));

      // goal glow, bay and force field
      o.stripMat.emissiveIntensity = (p.alive ? 0.75 : 0.2) + o.flash * 0.3;
      o.bayMat.emissiveIntensity = (p.alive ? 0.18 : 0.04) + o.flash * 0.15;
      this.updateBarrier(o, p, dt);
      this.syncLifeTag(p.seat, p.lives, p.alive, dt);
      this.syncBadge(p.seat, p, dt);
      if (!p.alive) {
        // The goal light turns cold electric blue (steady: a flickering light is tiring to look at).
        o.light.color.set(0x66ccff);
        o.light.intensity = 7 + o.barrier.flash * 6;
      } else {
        o.light.color.set(SEATS[p.seat].color);
        o.light.intensity = 16 + o.flash * 3;
      }
      this.syncIce(o, p, dt);
    }
  }

  /** Frozen paddles get an ice shell, drifting frost, a shivering character and an icy tint. */
  private syncIce(o: SeatObj, p: PlayerState, dt: number): void {
    const chill = p.alive ? p.fx.chill : 0;
    const frozen = chill > 0;
    o.ice.visible = frozen;
    o.skin.emissive.set(frozen ? 0x35c8ff : 0x000000);
    o.skin.emissiveIntensity = frozen ? 0.3 : 0;
    if (!frozen) return;
    const geo = this.barGeometry(p.seat, p.h, PADDLE_R * 1.9);
    if (o.ice.geometry !== geo) o.ice.geometry = geo;
    // The shell is steady, then flickers while it is about to melt.
    o.iceMat.opacity = chill > 0.8 ? 0.42 : 0.15 + 0.3 * (0.5 + 0.5 * Math.sin(this.time * 30));
    if (Math.random() < dt * 22) {
      // Frost mist drifting off the paddle.
      const side = SIDES[p.seat];
      const along = (Math.random() * 2 - 1) * p.h;
      tmpColor.set(0xd2f8ff).multiplyScalar(0.55);
      this.particles.emit(o.bar.position.x + side.t.x * along, 0.55, o.bar.position.z + side.t.y * along, (Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.5, tmpColor, 0.4, 0.9, -0.2, 1);
    }
    if (chill < 0.12) {
      // It melts: a little shower of ice.
      const side = SIDES[p.seat];
      this.particles.burst(o.bar.position.x, o.bar.position.z, tmpColor.set(0xbff3ff).multiplyScalar(0.5), 6, 3, 0.3, 0.5, 2);
      void side;
    }
  }

  private updateBarrier(o: SeatObj, p: PlayerState, dt: number): void {
    const b = o.barrier;
    const out = !p.alive;
    const shield = p.alive && p.fx.shield > 0;
    const left = p.fx.shield;
    let target = 0;
    if (out) target = Math.min(1, o.fall * 1.6);
    else if (shield) target = left > 1.5 ? 1 : 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(this.time * 24)); // flickers when about to run out
    b.on += (target - b.on) * Math.min(1, dt * (shield ? 12 : 4));
    b.flash = Math.max(0, b.flash - dt * 5);
    b.electric = out;
    b.group.visible = b.on > 0.01;
    if (!b.group.visible) return;

    const u = b.mat.uniforms;
    u.uTime.value = this.time;
    u.uOn.value = b.on;
    u.uFlash.value = b.flash;
    u.uCalm.value = shield ? 1 : 0;
    (u.uColor.value as THREE.Color).set(out ? 0x3fa9ff : SEATS[p.seat].color);
    b.strip.color.set(out ? 0x9fe2ff : SEATS[p.seat].color);
    if (shield) b.strip.color.lerp(WHITE, 0.55);
    // The floor strip burns down with the shield's remaining time, so everyone can read how long it lasts.
    b.stripMesh.scale.x = shield ? Math.max(0.04, left / FX_SHIELD) : 1;
    b.strip.opacity = (shield ? 1 : 0.75 + 0.1 * Math.sin(this.time * 30)) * b.on + b.flash * 0.1;

    b.nextBolt -= dt;
    if (b.nextBolt <= 0) {
      // Re-draw the lightning between the goal posts a few times a second (only for the eliminated look;
      // a shield just gets one faint bolt).
      b.nextBolt = 0.06 + Math.random() * 0.09;
      b.bolts.forEach((line, idx) => {
        line.visible = out || (shield && idx === 0);
        if (!line.visible) return;
        const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
        const y0 = 0.2 + Math.random() * 1.0;
        const y1 = 0.2 + Math.random() * 1.0;
        for (let i = 0; i < BOLT_POINTS; i++) {
          const k = i / (BOLT_POINTS - 1);
          const edge = Math.sin(k * Math.PI); // the ends stay pinned to the posts
          pos.setXYZ(i, -GOAL_HALF + k * 2 * GOAL_HALF, y0 + (y1 - y0) * k + (Math.random() - 0.5) * 0.5 * edge, (Math.random() - 0.5) * 0.12 * edge);
        }
        pos.needsUpdate = true;
        (line.material as THREE.LineBasicMaterial).opacity = (Math.random() < 0.7 ? 0.7 : 0.2) * b.on * (shield ? 0.45 : 1) + b.flash * 0.1;
      });
    }
    // A few sparks along the eliminated field; particles glow from every angle, unlike 1-pixel lines.
    if (out && Math.random() < 0.5 * b.on) {
      const line = b.bolts[Math.floor(Math.random() * b.bolts.length)];
      const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
      const k = Math.floor(Math.random() * BOLT_POINTS);
      SPARK_POS.set(pos.getX(k), pos.getY(k), pos.getZ(k));
      b.group.localToWorld(SPARK_POS);
      tmpColor.set(Math.random() < 0.5 ? 0xbfeaff : 0x5fb8ff);
      this.particles.emit(SPARK_POS.x, SPARK_POS.y, SPARK_POS.z, (Math.random() - 0.5) * 1.2, (Math.random() - 0.3) * 1.2, (Math.random() - 0.5) * 1.2, tmpColor, 0.28, 0.16, 0, 1);
    }
  }

  private syncBalls(sim: Sim, dt: number): void {
    const alive = new Set<number>();
    let anyHeld = false;
    for (const b of sim.balls) {
      alive.add(b.id);
      let o = this.balls.get(b.id);
      if (!o) {
        const mat = new THREE.MeshStandardMaterial({ map: this.ballTex, color: 0xe6eaf5, roughness: 0.45, metalness: 0.35, emissive: 0xffffff, emissiveIntensity: 0.12 });
        const mesh = new THREE.Mesh(this.ballGeo, mat);
        mesh.castShadow = true;
        this.scene.add(mesh);
        o = { mesh, mat, scale: 0, px: b.x, py: b.y };
        this.balls.set(b.id, o);
      }
      const held = b.hold > 0;
      if (held) anyHeld = true;
      const target = held ? 0.35 + 0.65 * (1 - b.hold / SERVE_HOLD) : 1;
      o.scale += (target - o.scale) * Math.min(1, dt * 12);
      o.mesh.scale.setScalar(o.scale);
      o.mesh.position.set(b.x, BALL_R * o.scale + 0.02, b.y);

      // rolling
      const vx = b.x - o.px;
      const vz = b.y - o.py;
      const dist = Math.hypot(vx, vz);
      if (dist > 1e-5) {
        o.mesh.rotateOnWorldAxis(ROLL_AXIS.set(vz / dist, 0, -vx / dist), dist / BALL_R);
      }
      o.px = b.x;
      o.py = b.y;

      const tint = TINT.copy(this.ballTint(b));
      const fire = Math.min(1, b.boost / SMASH_BOOST);
      // A soft tint of the owner's colour; only a smashed ball glows (it is dangerous, so it should read).
      o.mat.emissive.copy(tint).lerp(WHITE, b.owner < 0 && !b.extra ? 1 : 0.35).lerp(FIRE, fire);
      o.mat.emissiveIntensity = 0.12 + fire * 0.45;

      // No permanent tail. Only a smashed ball leaves a short one, so the threat is readable.
      if (!held && fire > 0.15 && Math.random() < 0.8) {
        tint.copy(FIRE_TRAIL);
        this.particles.emit(b.x, BALL_R, b.y, 0, 0.1, 0, tint, 0.38 + fire * 0.12, 0.16, 0, 0);
      }
    }
    for (const id of [...this.balls.keys()]) if (!alive.has(id)) this.removeBall(id);

    this.serveRing.visible = anyHeld;
    if (anyHeld) {
      const held = sim.balls.find((b) => b.hold > 0);
      if (held) {
        const k = 1 - held.hold / SERVE_HOLD;
        this.serveRing.position.set(held.x, 0.05, held.y);
        this.serveRing.scale.setScalar(2.2 - k * 1.5);
        (this.serveRing.material as THREE.MeshBasicMaterial).opacity = 0.2 + k * 0.6;
      }
    }
  }

  private syncCrates(sim: Sim, dt: number): void {
    const live = new Set<number>();
    for (const c of sim.crates) {
      live.add(c.id);
      let o = this.crates.get(c.id);
      if (!o) o = this.makeCrate(c);
      const age = this.time - o.born;
      const pop = Math.min(1, age * 4);
      const s = pop < 1 ? 1 + Math.sin(pop * Math.PI) * 0.25 : 1;
      o.mesh.scale.setScalar(pop * s);
      o.mesh.position.set(c.x, 0.85 + Math.sin(this.time * 3 + c.id) * 0.12, c.y);
      o.mesh.rotation.y += dt * 1.4;
      o.ring.position.set(c.x, 0.06, c.y);
      o.ring.scale.setScalar(1.0 + 0.12 * Math.sin(this.time * 4));
      // flicker before it disappears
      const left = c.ttl - c.age;
      o.mesh.visible = left > 3 || Math.floor(this.time * 8) % 2 === 0;
      if (Math.random() < dt * 6) {
        tmpColor.set(CRATE_INFO[o.kind].color);
        this.particles.emit(c.x + (Math.random() - 0.5), 1.4, c.y + (Math.random() - 0.5), 0, 0.8, 0, tmpColor, 0.3, 0.8, 0, 0);
      }
    }
    for (const id of [...this.crates.keys()]) if (!live.has(id)) this.removeCrate(id);
  }

  private makeCrate(c: Crate): CrateObj {
    let tex = this.crateTex.get(c.kind);
    if (!tex) {
      tex = itemTexture(c.kind);
      this.crateTex.set(c.kind, tex);
    }
    const col = CRATE_INFO[c.kind].color;
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissive: col, emissiveIntensity: 0.25 });
    const m = new THREE.Mesh(new RoundedBoxGeometry(1.15, 1.15, 1.15, 3, 0.08), mat);
    m.castShadow = true;
    g.add(m);
    this.scene.add(g);
    const ringMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    const o: CrateObj = { mesh: g, ring, mat, ringMat, born: this.time, kind: c.kind };
    this.crates.set(c.id, o);
    return o;
  }

  private startGhost(ev: Extract<SimEvent, { t: 'goal' }>): void {
    const obj = this.balls.get(ev.id);
    if (!obj) return;
    this.balls.delete(ev.id); // the sim forgot it; the view lets it finish its flight
    this.ghosts.push({ obj, x: ev.x, z: ev.y, y: BALL_R, vx: ev.vx, vz: ev.vy, vy: 0, seat: ev.seat, sinking: 0, t: 0 });
  }

  private updateGhosts(dt: number): void {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      const side = SIDES[g.seat];
      g.t += dt;
      const depth = -((g.x - side.w.x) * side.n.x + (g.z - side.w.y) * side.n.y); // distance behind the goal line
      if (!g.sinking && depth > 2.4) {
        // Caught by the net: a soft puff, then it sinks out of sight.
        g.sinking = 0.0001;
        this.particles.burst(g.x, g.z, dim(this.seatColor(g.seat), 0.5), 10, 3, 0.25, 0.4, 1.5);
      }
      const drag = Math.exp(-(g.sinking ? 7 : 2.2) * dt);
      g.vx *= drag;
      g.vz *= drag;
      g.x += g.vx * dt;
      g.z += g.vz * dt;
      if (g.sinking) {
        g.sinking += dt;
        g.vy -= 14 * dt;
        g.y += g.vy * dt;
      }
      const scale = g.sinking ? Math.max(0, 1 - g.sinking * 1.6) : 1;
      g.obj.mesh.position.set(g.x, g.y, g.z);
      g.obj.mesh.scale.setScalar(scale);
      if (scale <= 0 || g.t > 3) {
        this.scene.remove(g.obj.mesh);
        g.obj.mat.dispose();
        this.ghosts.splice(i, 1);
      }
    }
  }

  /** Lowers the render resolution when frames are slow, and raises it again when there is headroom. */
  private adaptQuality(): void {
    const now = performance.now();
    const ms = Math.min(100, now - this.lastFrame);
    this.lastFrame = now;
    this.frameMs += (ms - this.frameMs) * 0.05;
    const step = ms / 1000;
    this.slowFor = this.frameMs > 24 ? this.slowFor + step : 0;
    this.fastFor = this.frameMs < 13 ? this.fastFor + step : 0;
    if (this.slowFor > 1.5 && this.quality > 0.5) {
      this.quality = Math.max(0.5, this.quality - 0.15);
      this.slowFor = 0;
      this.resize();
    } else if (this.fastFor > 6 && this.quality < 1) {
      this.quality = Math.min(1, this.quality + 0.15);
      this.fastFor = 0;
      this.resize();
    }
  }

  private updateRings(dt: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) {
        this.scene.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      r.mesh.scale.setScalar(0.1 + (r.max - 0.1) * (1 - Math.pow(1 - k, 3)));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = r.opacity * (1 - k);
    }
  }

  private applyWinLights(): void {
    const k = 1 - 0.68 * this.win;
    this.hemi.intensity = HEMI_BASE * k;
    this.sun.intensity = SUN_BASE * k;
    this.spot.intensity = 380 * this.win;
  }

  /** Eases the winner focus in and keeps the spotlight on the winner. */
  private updateWin(dt: number): void {
    const target = this.winSeat >= 0 ? 1 : 0;
    this.win += (target - this.win) * Math.min(1, dt * 2.2);
    if (target === 0 && this.win < 0.002) this.win = 0;
    this.applyWinLights();
    if (this.winSeat < 0) return;
    const side = SIDES[this.winSeat];
    this.spot.color.set(SEATS[this.winSeat].color).lerp(WHITE, 0.55);
    this.spot.position.set(this.winPos.x + side.n.x * 3.5, 10, this.winPos.z + side.n.y * 3.5);
    this.spot.target.position.set(this.winPos.x, 1.0, this.winPos.z);
  }

  private updateCamera(dt: number): void {
    this.cine += (this.cineTarget - this.cine) * Math.min(1, dt * 2.5);
    const cine = this.cine;
    const az = (this.viewSeat * Math.PI) / 2 + Math.sin(this.time * 0.17) * 0.38 * cine;
    const elev = THREE.MathUtils.degToRad(58 - 14 * cine);
    const d = this.fitDist * (1 - 0.16 * cine);
    this.camera.position.set(Math.sin(az) * Math.cos(elev) * d, Math.sin(elev) * d, Math.cos(az) * Math.cos(elev) * d);

    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const sh = this.trauma * this.trauma * 0.9;
    this.camera.position.x += (Math.random() - 0.5) * sh;
    this.camera.position.y += (Math.random() - 0.5) * sh;
    this.camera.position.z += (Math.random() - 0.5) * sh;
    // Wide screens: aim a little toward the near goal, which perspective makes the largest.
    const off = this.wide ? 0.9 * (1 - cine) : 0;
    const ox = Math.sin(az) * off;
    const oz = Math.cos(az) * off;
    this.camera.position.x += ox;
    this.camera.position.z += oz;
    this.camera.lookAt(ox, 0, oz);

    if (this.win > 0.001 && this.winSeat >= 0) {
      // Close-up of the winner: the camera stands in the field in front of their goal and drifts slowly around.
      const side = SIDES[this.winSeat];
      const e = this.win * this.win * (3 - 2 * this.win);
      const ang = Math.atan2(side.n.x, side.n.y) + Math.sin(this.time * 0.5) * 0.16;
      const el = 0.36;
      const dist = 14;
      const px = this.winPos.x + Math.sin(ang) * Math.cos(el) * dist;
      const py = Math.sin(el) * dist + 1.0;
      const pz = this.winPos.z + Math.cos(ang) * Math.cos(el) * dist;
      this.camera.position.x += (px - this.camera.position.x) * e;
      this.camera.position.y += (py - this.camera.position.y) * e;
      this.camera.position.z += (pz - this.camera.position.z) * e;
      this.camera.lookAt(ox + (this.winPos.x - ox) * e, 1.2 * e, oz + (this.winPos.z - oz) * e);
    }

    // The scene sits to the right of the menu / results panel on wide screens, so the winner stays clear.
    const shift = Math.max(0.16 * cine, 0.17 * this.win);
    if (this.width / this.height > 1.2 && shift > 0.002) {
      this.camera.setViewOffset(this.width, this.height, -this.width * shift, 0, this.width, this.height);
    } else {
      this.camera.clearViewOffset();
    }
  }

  /** Projects a world point to CSS pixels (used for floating labels). */
  project(x: number, y: number, z: number): { x: number; y: number } {
    const v = PROJ.set(x, y, z).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }
}

function clamp01(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
