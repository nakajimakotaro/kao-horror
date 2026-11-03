import * as THREE from 'three';
import { PostPass } from './PostPass';

/**
 * Owns the WebGL renderer. The world is rendered into a small HDR render target
 * (PS1-ish resolution) and then upscaled through the retro post pass. A second
 * "view" scene (hand-held flashlight) is drawn on top with a cleared depth buffer.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly viewScene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly post = new PostPass();
  private rt: THREE.WebGLRenderTarget;
  pixelHeight = 360;
  baseFov = 70;
  fovOffset = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.autoClear = false;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, 16 / 9, 0.03, 220);
    this.scene.add(this.camera);
    this.rt = this.makeTarget(640, 360);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      generateMipmaps: false,
    });
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    return rt;
  }

  setPixelHeight(h: number): void {
    this.pixelHeight = h;
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const aspect = w / Math.max(1, h);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const ph = this.pixelHeight >= 2000 ? h : Math.min(this.pixelHeight, h);
    const pw = Math.max(2, Math.round(ph * aspect));
    this.rt.setSize(pw, ph);
    this.post.u.uRes.value.set(pw, ph);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post.u.uScreen.value.copy(size);
  }

  render(time: number): void {
    const fov = this.baseFov + this.fovOffset;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.setClearColor(this.scene.background instanceof THREE.Color ? this.scene.background : new THREE.Color(0), 1);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);
    if (this.viewScene.children.length) {
      r.clearDepth();
      r.render(this.viewScene, this.camera);
    }
    this.post.u.uTime.value = time;
    this.post.render(r, this.rt.texture);
  }
}
