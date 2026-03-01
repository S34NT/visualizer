use js_sys::Math;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

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

#[derive(Clone, Copy, Default)]
struct Vec3 {
    x: f32,
    y: f32,
    z: f32,
}

impl Vec3 {
    fn length(self) -> f32 {
        (self.x * self.x + self.y * self.y + self.z * self.z).sqrt()
    }

    fn add_assign(&mut self, rhs: Vec3) {
        self.x += rhs.x;
        self.y += rhs.y;
        self.z += rhs.z;
    }

    fn scale_assign(&mut self, factor: f32) {
        self.x *= factor;
        self.y *= factor;
        self.z *= factor;
    }
}

#[derive(Clone, Copy)]
struct Boid {
    position: Vec3,
    velocity: Vec3,
}

type CellKey = (i32, i32, i32);

#[wasm_bindgen]
pub struct FlockSim {
    boids: Vec<Boid>,
    bounds: f32,
    params: SimParams,
    positions: Vec<f32>,
    next_velocities: Vec<Vec3>,
    neighbor_scratch: Vec<usize>,
    cells: HashMap<CellKey, Vec<usize>>,
    cell_size: f32,
}

#[wasm_bindgen]
impl FlockSim {
    #[wasm_bindgen(constructor)]
    pub fn new(count: usize, bounds: f32, params: SimParams) -> FlockSim {
        let mut sim = FlockSim {
            boids: Vec::with_capacity(count),
            bounds,
            positions: vec![0.0; count * 3],
            next_velocities: vec![Vec3::default(); count],
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
        let current = self.boids.len();
        if new_count > current {
            for _ in current..new_count {
                self.boids.push(self.make_random_boid());
            }
        } else {
            self.boids.truncate(new_count);
        }

        self.positions.resize(new_count * 3, 0.0);
        self.next_velocities.resize(new_count, Vec3::default());
        self.write_positions();
    }

    pub fn reset(&mut self) {
        self.initialize_boids(self.boids.len());
    }

    pub fn count(&self) -> usize {
        self.boids.len()
    }

    pub fn update(&mut self) {
        self.rebuild_spatial_grid();

        let vis_sq = self.params.visual_range * self.params.visual_range;
        let protected_sq = self.params.protected_range * self.params.protected_range;

        if self.next_velocities.len() != self.boids.len() {
            self.next_velocities
                .resize(self.boids.len(), Vec3::default());
        }

        let mut neighbors = std::mem::take(&mut self.neighbor_scratch);

        for i in 0..self.boids.len() {
            let boid = self.boids[i];
            neighbors.clear();
            self.collect_neighbor_indices(boid.position, &mut neighbors);

            let mut close = Vec3::default();
            let mut avg_vel = Vec3::default();
            let mut avg_pos = Vec3::default();
            let mut count = 0.0_f32;

            for &n_idx in &neighbors {
                if n_idx == i {
                    continue;
                }

                let other = self.boids[n_idx];
                let dx = boid.position.x - other.position.x;
                let dy = boid.position.y - other.position.y;
                let dz = boid.position.z - other.position.z;
                let dist_sq = dx * dx + dy * dy + dz * dz;

                if dist_sq < protected_sq && dist_sq > 0.0 {
                    close.x += dx;
                    close.y += dy;
                    close.z += dz;
                }

                if dist_sq < vis_sq {
                    avg_vel.add_assign(other.velocity);
                    avg_pos.add_assign(other.position);
                    count += 1.0;
                }
            }

            let mut velocity = boid.velocity;

            velocity.x += close.x * self.params.avoid_factor;
            velocity.y += close.y * self.params.avoid_factor;
            velocity.z += close.z * self.params.avoid_factor;

            if count > 0.0 {
                avg_vel.scale_assign(1.0 / count);
                avg_pos.scale_assign(1.0 / count);

                velocity.x += (avg_vel.x - velocity.x) * self.params.matching_factor;
                velocity.y += (avg_vel.y - velocity.y) * self.params.matching_factor;
                velocity.z += (avg_vel.z - velocity.z) * self.params.matching_factor;

                velocity.x += (avg_pos.x - boid.position.x) * self.params.centering_factor;
                velocity.y += (avg_pos.y - boid.position.y) * self.params.centering_factor;
                velocity.z += (avg_pos.z - boid.position.z) * self.params.centering_factor;
            }

            self.avoid_boundaries(boid.position, &mut velocity);
            self.limit_speed(&mut velocity);
            self.next_velocities[i] = velocity;
        }

        self.neighbor_scratch = neighbors;

        for (idx, boid) in self.boids.iter_mut().enumerate() {
            boid.velocity = self.next_velocities[idx];
            boid.position.add_assign(boid.velocity);
        }

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
}

impl FlockSim {
    fn initialize_boids(&mut self, count: usize) {
        self.boids.clear();
        self.boids.reserve(count);

        for _ in 0..count {
            self.boids.push(self.make_random_boid());
        }

        self.write_positions();
    }

    fn write_positions(&mut self) {
        for (idx, boid) in self.boids.iter().enumerate() {
            let out = idx * 3;
            self.positions[out] = boid.position.x;
            self.positions[out + 1] = boid.position.y;
            self.positions[out + 2] = boid.position.z;
        }
    }

    fn make_random_boid(&self) -> Boid {
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

        Boid {
            position: Vec3 {
                x: random_position(),
                y: random_position(),
                z: random_position(),
            },
            velocity: Vec3 {
                x: vx,
                y: vy,
                z: vz,
            },
        }
    }

    fn rebuild_spatial_grid(&mut self) {
        self.cells.clear();
        for (idx, boid) in self.boids.iter().enumerate() {
            let key = self.cell_key(boid.position);
            self.cells.entry(key).or_default().push(idx);
        }
    }

    fn cell_key(&self, position: Vec3) -> CellKey {
        (
            (position.x / self.cell_size).floor() as i32,
            (position.y / self.cell_size).floor() as i32,
            (position.z / self.cell_size).floor() as i32,
        )
    }

    fn collect_neighbor_indices(&self, position: Vec3, out: &mut Vec<usize>) {
        let (cx, cy, cz) = self.cell_key(position);

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

    fn avoid_boundaries(&self, position: Vec3, velocity: &mut Vec3) {
        let b = self.bounds;
        let m = self.params.margin;
        let t = self.params.turn_factor;

        if position.x < -b + m {
            velocity.x += t;
        } else if position.x > b - m {
            velocity.x -= t;
        }

        if position.y < -b + m {
            velocity.y += t;
        } else if position.y > b - m {
            velocity.y -= t;
        }

        if position.z < -b + m {
            velocity.z += t;
        } else if position.z > b - m {
            velocity.z -= t;
        }
    }

    fn limit_speed(&self, velocity: &mut Vec3) {
        let speed = velocity.length();

        if speed > 0.0 && speed < self.params.min_speed {
            velocity.scale_assign(self.params.min_speed / speed);
        } else if speed > self.params.max_speed {
            velocity.scale_assign(self.params.max_speed / speed);
        }
    }
}
