uniform vec3 origin;
uniform float maxDistance;
uniform float time;
uniform float particleSize;

varying vec3 vColor;

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

void main() {
  // Calculate vector from origin to particle
  vec3 delta = position - origin;
  float dist = length(delta);
  
  // Calculate hue from XY angle (0-360°)
  // atan returns -PI to PI, we convert to 0-360
  float hue = atan(delta.y, delta.x) * 57.2957795; // radians to degrees
  if (hue < 0.0) hue += 360.0;
  
  // Modulate hue with Z position for 3D color variation
  // This creates a beautiful spiral effect as birds move through space
  float zInfluence = (delta.z / maxDistance) * 60.0;
  hue = mod(hue + zInfluence + 360.0, 360.0);
  
  // Add subtle time-based shimmer
  hue = mod(hue + sin(time * 0.5 + dist * 0.02) * 5.0 + 360.0, 360.0);
  
  // Calculate lightness from distance
  // Brightest at origin (80%), darkest at maxDistance (40%)
  float normalizedDist = min(dist / maxDistance, 1.0);
  float lightness = 0.4 + 0.4 * (1.0 - normalizedDist);
  
  // Full saturation for vibrant colors
  float saturation = 0.9;
  
  // Convert HSL to RGB
  vColor = hsl2rgb(hue, saturation, lightness);
  
  // Transform position
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  
  // Size attenuation - particles get smaller with distance
  // Base size scaled by distance from camera
  float sizeAttenuation = 300.0 / -mvPosition.z;
  gl_PointSize = particleSize * sizeAttenuation;
  
  // Clamp point size to reasonable range
  gl_PointSize = clamp(gl_PointSize, 1.0, 20.0);
}




