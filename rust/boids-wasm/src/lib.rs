use js_sys::Math;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
use core::arch::wasm32::{f32x4_add, v128, v128_load, v128_store};

#[wasm_bindgen]
#[derive(Clone)]
pub struct SimParams {
    pub visual_range: f32,
    pub protected_range: f32,
    pub centering_factor: f32,
    pub avoid_factor: f32,
    pub matching_factor: f32,
    pub max_speed: f32,
    pub min_speed: f32,
    pub turn_factor: f32,
    pub margin: f32,
}

#[wasm_bindgen]
impl SimParams {
    #[wasm_bindgen(constructor)]
    pub fn new(
        visual_range: f32,
        protected_range: f32,
        centering_factor: f32,
        avoid_factor: f32,
        matching_factor: f32,
        max_speed: f32,
        min_speed: f32,
        turn_factor: f32,
        margin: f32,
    ) -> SimParams {
        SimParams {
            visual_range,
            protected_range,
            centering_factor,
            avoid_factor,
            matching_factor,
            max_speed,
            min_speed,
            turn_factor,
            margin,
        }
    }
}

type CellKey = (i32, i32, i32);

#[wasm_bindgen]
pub struct FlockSim {
    pos_x: Vec<f32>,
    pos_y: Vec<f32>,
    pos_z: Vec<f32>,
    vel_x: Vec<f32>,
    vel_y: Vec<f32>,
    vel_z: Vec<f32>,
    next_vel_x: Vec<f32>,
    next_vel_y: Vec<f32>,
    next_vel_z: Vec<f32>,
    bounds: f32,
    params: SimParams,
    positions: Vec<f32>,
    neighbor_scratch: Vec<usize>,
    cells: HashMap<CellKey, Vec<usize>>,
    cell_size: f32,
}

#[wasm_bindgen]
impl FlockSim {
    #[wasm_bindgen(constructor)]
    pub fn new(count: usize, bounds: f32, params: SimParams) -> FlockSim {
        let mut sim = FlockSim {
            pos_x: Vec::with_capacity(count),
            pos_y: Vec::with_capacity(count),
            pos_z: Vec::with_capacity(count),
            vel_x: Vec::with_capacity(count),
            vel_y: Vec::with_capacity(count),
            vel_z: Vec::with_capacity(count),
            next_vel_x: vec![0.0; count],
            next_vel_y: vec![0.0; count],
            next_vel_z: vec![0.0; count],
            bounds,
            positions: vec![0.0; count * 3],
            neighbor_scratch: Vec::new(),
            cell_size: params.visual_range.max(1.0),
            cells: HashMap::new(),
            params,
        };

        sim.initialize_boids(count);
        sim
    }

    pub fn set_params(&mut self, params: SimParams) {
        self.cell_size = params.visual_range.max(1.0);
        self.params = params;
    }

    pub fn set_count(&mut self, new_count: usize) {
        let current = self.count();
        if new_count > current {
            self.pos_x.reserve(new_count - current);
            self.pos_y.reserve(new_count - current);
            self.pos_z.reserve(new_count - current);
            self.vel_x.reserve(new_count - current);
            self.vel_y.reserve(new_count - current);
            self.vel_z.reserve(new_count - current);

            for _ in current..new_count {
                let (px, py, pz, vx, vy, vz) = self.make_random_boid();
                self.pos_x.push(px);
                self.pos_y.push(py);
                self.pos_z.push(pz);
                self.vel_x.push(vx);
                self.vel_y.push(vy);
                self.vel_z.push(vz);
            }
        } else {
            self.pos_x.truncate(new_count);
            self.pos_y.truncate(new_count);
            self.pos_z.truncate(new_count);
            self.vel_x.truncate(new_count);
            self.vel_y.truncate(new_count);
            self.vel_z.truncate(new_count);
        }

        self.positions.resize(new_count * 3, 0.0);
        self.next_vel_x.resize(new_count, 0.0);
        self.next_vel_y.resize(new_count, 0.0);
        self.next_vel_z.resize(new_count, 0.0);
        self.write_positions();
    }

    pub fn reset(&mut self) {
        self.initialize_boids(self.count());
    }

    pub fn count(&self) -> usize {
        self.pos_x.len()
    }

    pub fn update(&mut self) {
        self.rebuild_spatial_grid();

        let vis_sq = self.params.visual_range * self.params.visual_range;
        let protected_sq = self.params.protected_range * self.params.protected_range;

        let boid_count = self.count();
        if self.next_vel_x.len() != boid_count {
            self.next_vel_x.resize(boid_count, 0.0);
            self.next_vel_y.resize(boid_count, 0.0);
            self.next_vel_z.resize(boid_count, 0.0);
        }

        let mut neighbors = std::mem::take(&mut self.neighbor_scratch);

        for i in 0..boid_count {
            let px = self.pos_x[i];
            let py = self.pos_y[i];
            let pz = self.pos_z[i];
            neighbors.clear();
            self.collect_neighbor_indices(px, py, pz, &mut neighbors);

            let mut close_x = 0.0;
            let mut close_y = 0.0;
            let mut close_z = 0.0;
            let mut avg_vx = 0.0;
            let mut avg_vy = 0.0;
            let mut avg_vz = 0.0;
            let mut avg_px = 0.0;
            let mut avg_py = 0.0;
            let mut avg_pz = 0.0;
            let mut count = 0.0_f32;

            for &n_idx in &neighbors {
                if n_idx == i {
                    continue;
                }

                let dx = px - self.pos_x[n_idx];
                let dy = py - self.pos_y[n_idx];
                let dz = pz - self.pos_z[n_idx];
                let dist_sq = dx * dx + dy * dy + dz * dz;

                if dist_sq < protected_sq && dist_sq > 0.0 {
                    close_x += dx;
                    close_y += dy;
                    close_z += dz;
                }

                if dist_sq < vis_sq {
                    avg_vx += self.vel_x[n_idx];
                    avg_vy += self.vel_y[n_idx];
                    avg_vz += self.vel_z[n_idx];
                    avg_px += self.pos_x[n_idx];
                    avg_py += self.pos_y[n_idx];
                    avg_pz += self.pos_z[n_idx];
                    count += 1.0;
                }
            }

            let mut vx = self.vel_x[i] + close_x * self.params.avoid_factor;
            let mut vy = self.vel_y[i] + close_y * self.params.avoid_factor;
            let mut vz = self.vel_z[i] + close_z * self.params.avoid_factor;

            if count > 0.0 {
                let inv_count = 1.0 / count;
                avg_vx *= inv_count;
                avg_vy *= inv_count;
                avg_vz *= inv_count;
                avg_px *= inv_count;
                avg_py *= inv_count;
                avg_pz *= inv_count;

                vx += (avg_vx - vx) * self.params.matching_factor;
                vy += (avg_vy - vy) * self.params.matching_factor;
                vz += (avg_vz - vz) * self.params.matching_factor;

                vx += (avg_px - px) * self.params.centering_factor;
                vy += (avg_py - py) * self.params.centering_factor;
                vz += (avg_pz - pz) * self.params.centering_factor;
            }

            self.avoid_boundaries(px, py, pz, &mut vx, &mut vy, &mut vz);
            self.limit_speed(&mut vx, &mut vy, &mut vz);

            self.next_vel_x[i] = vx;
            self.next_vel_y[i] = vy;
            self.next_vel_z[i] = vz;
        }

        self.neighbor_scratch = neighbors;

        self.integrate_velocities_and_positions(boid_count);
        self.write_positions();
    }

    pub fn positions_ptr(&self) -> *const f32 {
        self.positions.as_ptr()
    }

    pub fn positions_len(&self) -> usize {
        self.positions.len()
    }

    pub fn positions(&self) -> Vec<f32> {
        self.positions.clone()
    }

    pub fn simd_enabled(&self) -> bool {
        cfg!(all(target_arch = "wasm32", target_feature = "simd128"))
    }
}

impl FlockSim {
    fn initialize_boids(&mut self, count: usize) {
        self.pos_x.clear();
        self.pos_y.clear();
        self.pos_z.clear();
        self.vel_x.clear();
        self.vel_y.clear();
        self.vel_z.clear();

        self.pos_x.reserve(count);
        self.pos_y.reserve(count);
        self.pos_z.reserve(count);
        self.vel_x.reserve(count);
        self.vel_y.reserve(count);
        self.vel_z.reserve(count);

        for _ in 0..count {
            let (px, py, pz, vx, vy, vz) = self.make_random_boid();
            self.pos_x.push(px);
            self.pos_y.push(py);
            self.pos_z.push(pz);
            self.vel_x.push(vx);
            self.vel_y.push(vy);
            self.vel_z.push(vz);
        }

        self.next_vel_x.resize(count, 0.0);
        self.next_vel_y.resize(count, 0.0);
        self.next_vel_z.resize(count, 0.0);
        self.positions.resize(count * 3, 0.0);
        self.write_positions();
    }

    fn write_positions(&mut self) {
        for idx in 0..self.count() {
            let out = idx * 3;
            self.positions[out] = self.pos_x[idx];
            self.positions[out + 1] = self.pos_y[idx];
            self.positions[out + 2] = self.pos_z[idx];
        }
    }

    fn make_random_boid(&self) -> (f32, f32, f32, f32, f32, f32) {
        let scale = self.bounds * 0.8;
        let random_position = || (Math::random() as f32 - 0.5) * 2.0 * scale;

        let mut vx = (Math::random() as f32 - 0.5) * 2.0;
        let mut vy = (Math::random() as f32 - 0.5) * 2.0;
        let mut vz = (Math::random() as f32 - 0.5) * 2.0;
        let mag = (vx * vx + vy * vy + vz * vz).sqrt().max(1e-6);
        let speed = Math::random() as f32 * 3.0 + 2.0;
        vx = (vx / mag) * speed;
        vy = (vy / mag) * speed;
        vz = (vz / mag) * speed;

        (
            random_position(),
            random_position(),
            random_position(),
            vx,
            vy,
            vz,
        )
    }

    fn rebuild_spatial_grid(&mut self) {
        self.cells.clear();
        for idx in 0..self.count() {
            let key = self.cell_key(self.pos_x[idx], self.pos_y[idx], self.pos_z[idx]);
            self.cells.entry(key).or_default().push(idx);
        }
    }

    fn cell_key(&self, x: f32, y: f32, z: f32) -> CellKey {
        (
            (x / self.cell_size).floor() as i32,
            (y / self.cell_size).floor() as i32,
            (z / self.cell_size).floor() as i32,
        )
    }

    fn collect_neighbor_indices(&self, x: f32, y: f32, z: f32, out: &mut Vec<usize>) {
        let (cx, cy, cz) = self.cell_key(x, y, z);

        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(cell) = self.cells.get(&(cx + dx, cy + dy, cz + dz)) {
                        out.extend(cell.iter().copied());
                    }
                }
            }
        }
    }

    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    fn integrate_velocities_and_positions(&mut self, boid_count: usize) {
        let mut i = 0;
        while i + 4 <= boid_count {
            unsafe {
                let next_vx = v128_load(self.next_vel_x.as_ptr().add(i) as *const v128);
                let next_vy = v128_load(self.next_vel_y.as_ptr().add(i) as *const v128);
                let next_vz = v128_load(self.next_vel_z.as_ptr().add(i) as *const v128);

                v128_store(self.vel_x.as_mut_ptr().add(i) as *mut v128, next_vx);
                v128_store(self.vel_y.as_mut_ptr().add(i) as *mut v128, next_vy);
                v128_store(self.vel_z.as_mut_ptr().add(i) as *mut v128, next_vz);

                let pos_x = v128_load(self.pos_x.as_ptr().add(i) as *const v128);
                let pos_y = v128_load(self.pos_y.as_ptr().add(i) as *const v128);
                let pos_z = v128_load(self.pos_z.as_ptr().add(i) as *const v128);

                v128_store(
                    self.pos_x.as_mut_ptr().add(i) as *mut v128,
                    f32x4_add(pos_x, next_vx),
                );
                v128_store(
                    self.pos_y.as_mut_ptr().add(i) as *mut v128,
                    f32x4_add(pos_y, next_vy),
                );
                v128_store(
                    self.pos_z.as_mut_ptr().add(i) as *mut v128,
                    f32x4_add(pos_z, next_vz),
                );
            }
            i += 4;
        }

        while i < boid_count {
            self.vel_x[i] = self.next_vel_x[i];
            self.vel_y[i] = self.next_vel_y[i];
            self.vel_z[i] = self.next_vel_z[i];
            self.pos_x[i] += self.vel_x[i];
            self.pos_y[i] += self.vel_y[i];
            self.pos_z[i] += self.vel_z[i];
            i += 1;
        }
    }

    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    fn integrate_velocities_and_positions(&mut self, boid_count: usize) {
        for i in 0..boid_count {
            self.vel_x[i] = self.next_vel_x[i];
            self.vel_y[i] = self.next_vel_y[i];
            self.vel_z[i] = self.next_vel_z[i];
            self.pos_x[i] += self.vel_x[i];
            self.pos_y[i] += self.vel_y[i];
            self.pos_z[i] += self.vel_z[i];
        }
    }

    fn avoid_boundaries(
        &self,
        px: f32,
        py: f32,
        pz: f32,
        vx: &mut f32,
        vy: &mut f32,
        vz: &mut f32,
    ) {
        let b = self.bounds;
        let m = self.params.margin;
        let t = self.params.turn_factor;

        if px < -b + m {
            *vx += t;
        } else if px > b - m {
            *vx -= t;
        }

        if py < -b + m {
            *vy += t;
        } else if py > b - m {
            *vy -= t;
        }

        if pz < -b + m {
            *vz += t;
        } else if pz > b - m {
            *vz -= t;
        }
    }

    fn limit_speed(&self, vx: &mut f32, vy: &mut f32, vz: &mut f32) {
        let speed = (*vx * *vx + *vy * *vy + *vz * *vz).sqrt();

        if speed > 0.0 && speed < self.params.min_speed {
            let scale = self.params.min_speed / speed;
            *vx *= scale;
            *vy *= scale;
            *vz *= scale;
        } else if speed > self.params.max_speed {
            let scale = self.params.max_speed / speed;
            *vx *= scale;
            *vy *= scale;
            *vz *= scale;
        }
    }
}
