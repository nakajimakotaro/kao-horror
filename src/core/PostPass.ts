import * as THREE from 'three';

const vertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Low-res HDR scene → tone map → sRGB → ordered dither/quantize → grain,
// vignette, fear distortion, eyelids, fades. Everything the player "feels"
// on screen goes through these uniforms.
const fragment = /* glsl */ `
precision highp float;
uniform sampler2D tScene;
uniform vec2 uRes;
uniform vec2 uScreen;
uniform float uTime;
uniform float uFear;
uniform float uEyes;
uniform float uFade;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uFisheye;
uniform float uExposure;
uniform float uGamma;
uniform float uGrain;
uniform float uVignette;
uniform float uStatic;
uniform float uRed;
uniform float uLevels;
uniform float uDream;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 aces(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43; const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float bayer4(vec2 p) {
  vec2 q = mod(p, 4.0);
  int i = int(q.x) + int(q.y) * 4;
  float m[16];
  m[0]=0.0; m[1]=8.0; m[2]=2.0; m[3]=10.0; m[4]=12.0; m[5]=4.0; m[6]=14.0; m[7]=6.0;
  m[8]=3.0; m[9]=11.0; m[10]=1.0; m[11]=9.0; m[12]=15.0; m[13]=7.0; m[14]=13.0; m[15]=5.0;
  float v = 0.0;
  for (int k = 0; k < 16; k++) { if (k == i) v = m[k]; }
  return v / 16.0;
}

void main() {
  vec2 uv = vUv;
  float aspect = uScreen.x / uScreen.y;
  if (uFisheye > 0.0) {
    vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
    float r = length(c);
    float k = 1.0 + uFisheye * (0.9 * r * r);
    c *= k * mix(1.0, 0.62, uFisheye);
    uv = c / vec2(aspect, 1.0) + 0.5;
  }
  float fear2 = uFear * uFear;
  uv.x += sin(uv.y * 38.0 + uTime * 7.0) * 0.0025 * fear2;
  uv.y += sin(uv.x * 22.0 + uTime * 5.0) * 0.0015 * fear2;
  uv += vec2(sin(uTime * 0.7), cos(uTime * 0.53)) * 0.004 * uDream;
  float band = floor(uv.y * uRes.y * 0.25);
  float glitch = step(0.992 - (uStatic + fear2) * 0.08, hash(vec2(band, floor(uTime * 24.0))));
  uv.x += glitch * (hash(vec2(uTime, band)) - 0.5) * 0.05 * (uFear + uStatic);

  vec2 dir = uv - 0.5;
  float ca = 0.0012 + uFear * 0.007 + uDream * 0.004;
  vec3 col;
  col.r = texture2D(tScene, uv + dir * ca).r;
  col.g = texture2D(tScene, uv).g;
  col.b = texture2D(tScene, uv - dir * ca).b;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);

  col *= uExposure;
  col = aces(col);
  col = toSRGB(col);
  col = pow(max(col, vec3(0.0)), vec3(1.0 / uGamma));

  vec2 px = floor(vUv * uRes);
  col += (bayer4(px) - 0.5) / uLevels;
  col = floor(col * uLevels + 0.5) / uLevels;

  float n = hash(px + fract(uTime * 7.13) * 91.7) - 0.5;
  col += n * (uGrain + uFear * 0.10 + uStatic * 0.35);
  col = mix(col, vec3(hash(px * 1.31 + uTime * 61.0)), uStatic * 0.55);
  float scan = 0.94 + 0.06 * sin(vUv.y * uScreen.y * 1.4);
  col *= mix(1.0, scan, 0.5);

  vec2 vc = (vUv - 0.5) * vec2(aspect * 0.8, 1.0);
  float vig = smoothstep(0.95 - uFear * 0.35, 0.25 - uFear * 0.2, length(vc));
  col *= mix(1.0, vig, clamp(uVignette + uFear * 0.6, 0.0, 1.0));
  col = mix(col, col * vec3(1.25, 0.5, 0.48), clamp(uFear * 0.4 + uRed, 0.0, 1.0));
  col = mix(col, vec3(dot(col, vec3(0.33))) * vec3(0.85, 0.9, 1.1), uDream * 0.5);

  if (uFisheye > 0.0) {
    float r = length((vUv - 0.5) * vec2(aspect, 1.0));
    col *= smoothstep(0.47, 0.43, r);
  }
  if (uEyes > 0.0) {
    float curve = (vUv.x - 0.5) * (vUv.x - 0.5) * 0.9;
    float open = (1.0 - uEyes) * 0.62 - curve;
    float lid = abs(vUv.y - 0.5);
    col *= smoothstep(open + 0.01, open - 0.06, lid);
    col *= 1.0 - smoothstep(0.82, 0.98, uEyes);
  }
  col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
  col *= 1.0 - clamp(uFade, 0.0, 1.0);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export class PostPass {
  readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tScene: { value: null },
        uRes: { value: new THREE.Vector2(640, 360) },
        uScreen: { value: new THREE.Vector2(1280, 720) },
        uTime: { value: 0 },
        uFear: { value: 0 },
        uEyes: { value: 0 },
        uFade: { value: 0 },
        uFlash: { value: 0 },
        uFlashColor: { value: new THREE.Color(1, 1, 1) },
        uFisheye: { value: 0 },
        uExposure: { value: 1 },
        uGamma: { value: 1 },
        uGrain: { value: 0.045 },
        uVignette: { value: 0.55 },
        uStatic: { value: 0 },
        uRed: { value: 0 },
        uLevels: { value: 40 },
        uDream: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get u() {
    return this.material.uniforms;
  }

  render(renderer: THREE.WebGLRenderer, tex: THREE.Texture): void {
    this.u.tScene.value = tex;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }
}
