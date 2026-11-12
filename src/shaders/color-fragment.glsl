varying vec3 vColor;
varying float vCore;

void main() {
  vec2 center = gl_PointCoord - vec2(0.5);
  float dist = length(center);

  if (dist > 0.5) discard;

  // soft disc with a hotter core for fast birds
  float alpha = (1.0 - smoothstep(0.28, 0.5, dist)) * 0.85;
  float core = (1.0 - smoothstep(0.0, 0.2, dist)) * vCore;
  vec3 finalColor = vColor * (1.0 + 0.3 * (1.0 - dist * 2.0)) + core * 0.25;

  gl_FragColor = vec4(finalColor * alpha, alpha);
}
