uniform vec3 origin;
uniform float maxDistance;
uniform float time;
uniform float particleSize;

// choreographed colour state
uniform float hue;          // degrees, rotates slowly over the show
uniform float hueSpread;    // how much position / direction spreads the hue
uniform float saturation;
uniform vec4 modeMix;       // weights: position, velocity, palette, lineage colour
uniform vec3 palette0;
uniform vec3 palette1;
uniform vec3 palette2;
uniform float flash;        // additive brightness on strong hits
uniform float sizePulse;    // beat-synced size swell
uniform float sparkle;      // probability of a bird glinting this frame
uniform float speedScale;   // 1 / maxSpeed
uniform vec4 bandHit;       // instrument-group hits: bass, low-mid, vocal/lead, treble

attribute vec3 velocity;
attribute float seed;       // per-bird random in [0,1)
attribute vec2 genome;      // x: lineage hue [0,1), y: energy [0,1]

varying vec3 vColor;
varying float vCore;

// HSL to RGB conversion
// Based on https://www.shadertoy.com/view/XljGzV
vec3 hsl2rgb(float h, float s, float l) {
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float x = c * (1.0 - abs(mod(h / 60.0, 2.0) - 1.0));
  float m = l - c / 2.0;

  vec3 rgb;

  if (h < 60.0) {
    rgb = vec3(c, x, 0.0);
  } else if (h < 120.0) {
    rgb = vec3(x, c, 0.0);
  } else if (h < 180.0) {
    rgb = vec3(0.0, c, x);
  } else if (h < 240.0) {
    rgb = vec3(0.0, x, c);
  } else if (h < 300.0) {
    rgb = vec3(x, 0.0, c);
  } else {
    rgb = vec3(c, 0.0, x);
  }

  return rgb + vec3(m);
}

vec3 paletteAt(float t) {
  // cyclic three-stop gradient
  float u = fract(t) * 3.0;
  if (u < 1.0) return mix(palette0, palette1, u);
  if (u < 2.0) return mix(palette1, palette2, u - 1.0);
  return mix(palette2, palette0, u - 2.0);
}

void main() {
  vec3 delta = position - origin;
  float dist = length(delta);
  float normalizedDist = min(dist / maxDistance, 1.0);

  // --- position colour: hue sweeps around the origin, shifted by depth ---
  float posHue = atan(delta.y, delta.x) * 57.2957795 + (delta.z / maxDistance) * 60.0;
  posHue = posHue * hueSpread + hue + sin(time * 0.5 + dist * 0.02) * 5.0;
  float lightP = 0.4 + 0.3 * (1.0 - normalizedDist);
  vec3 cPos = hsl2rgb(mod(posHue + 3600.0, 360.0), saturation, lightP);

  // --- velocity colour: heading sets hue, speed sets brightness ---------
  float speed = length(velocity);
  vec3 dir = velocity / max(speed, 1e-4);
  float velHue = (atan(dir.z, dir.x) * 57.2957795 + dir.y * 90.0) * hueSpread + hue + 140.0;
  float sp = clamp(speed * speedScale, 0.0, 1.0);
  vec3 cVel = hsl2rgb(mod(velHue + 3600.0, 360.0), saturation, 0.36 + 0.36 * sp);

  // --- palette colour: slow cyclic gradient through position and speed ---
  vec3 cPal = paletteAt(normalizedDist * 0.9 + seed * 0.3 + time * 0.02 + sp * 0.25);
  cPal *= 0.7 + 0.4 * (1.0 - normalizedDist);

  // --- lineage colour: inherited hue, energy sets brightness -------------
  float linHue = genome.x * 360.0 + hue * 0.25;
  vec3 cLin = hsl2rgb(mod(linHue + 3600.0, 360.0), 1.0, 0.28 + 0.2 * genome.y);

  vec3 color = cPos * modeMix.x + cVel * modeMix.y + cPal * modeMix.z + cLin * modeMix.w;

  // --- instrument group: the lineage-hue quadrant picks the band this bird
  // answers (same mapping as the cymatic band affinity in FieldLayout.js).
  float band = floor(fract(genome.x) * 4.0);
  vec4 member = vec4(equal(vec4(band), vec4(0.0, 1.0, 2.0, 3.0)));
  float hit = dot(member, bandHit);
  // Treble glitters: on each hit only a shifting half of the group lights.
  float glitter = step(0.45, fract(seed * 17.13 + floor(time * 14.0) * 0.618));
  hit *= mix(1.0, glitter, member.w);
  // Each band has its own gesture: bass swells, low-mid punches bright,
  // vocal/lead blooms, treble flickers.
  float hitSize = dot(member, vec4(0.9, 0.5, 0.8, 0.3));
  float hitBright = dot(member, vec4(0.8, 1.7, 1.1, 2.2));
  vec3 cHit = hsl2rgb(mod(linHue + 3600.0, 360.0), 1.0, 0.62);
  color = mix(color, cHit, 0.5 * min(hit, 1.0));

  // individual variation + glints
  color *= 0.78 + 0.44 * fract(seed * 7.31);
  float glint = step(1.0 - sparkle * 0.03, fract(seed * 43.7 + time * (1.3 + seed * 2.0)));
  color += glint * 0.6;
  color *= 1.0 + flash * 1.2;
  color *= 1.0 + hitBright * hit;

  vColor = color;
  vCore = min(1.0, 0.5 + 0.5 * sp + 0.4 * hit);

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float sizeAttenuation = 300.0 / -mvPosition.z;
  float size = particleSize * (0.65 + 0.7 * seed) * (1.0 + sizePulse * (0.4 + 0.6 * seed));
  size *= 1.0 + hitSize * hit;
  gl_PointSize = clamp(size * sizeAttenuation, 1.0, 20.0);
}
