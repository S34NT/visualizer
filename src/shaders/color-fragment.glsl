varying vec3 vColor;

void main() {
  // Calculate distance from center of point sprite
  // gl_PointCoord goes from (0,0) at top-left to (1,1) at bottom-right
  vec2 center = gl_PointCoord - vec2(0.5);
  float dist = length(center);
  
  // Discard pixels outside the circle
  if (dist > 0.5) discard;
  
  // Create soft edges with antialiasing
  // smoothstep creates a smooth transition from 0.35 to 0.5
  float alpha = 1.0 - smoothstep(0.35, 0.5, dist);
  
  // Add slight glow effect - brighter at center
  float glow = 1.0 + 0.3 * (1.0 - dist * 2.0);
  vec3 finalColor = vColor * glow;
  
  // Output with premultiplied alpha for additive blending
  gl_FragColor = vec4(finalColor * alpha, alpha);
}




