use js_sys::Math;
use wasm_bindgen::prelude::*;

#[cfg(feature = "parallel")]
use rayon::prelude::*;
/// `initThreadPool(n)` for the threaded build (requires cross-origin isolation).
#[cfg(feature = "parallel")]
pub use wasm_bindgen_rayon::init_thread_pool;

/// Size of the shared force-field buffer. Must match FIELD_SIZE in
/// src/fields/FieldLayout.js, which documents every index used below.
pub const FIELD_SIZE: usize = 160;

/// Number of hue bins used to track lineage dominance (matches HUE_BINS in FieldLayout.js).
const HUE_BINS: usize = 16;

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

#[wasm_bindgen]
pub struct FlockSim {
    pos_x: Vec<f32>,
    pos_y: Vec<f32>,
    pos_z: Vec<f32>,
    vel_x: Vec<f32>,
    vel_y: Vec<f32>,
    vel_z: Vec<f32>,
    step_out: Vec<BirdOut>,
    perm_tmp: Vec<f32>,
    traits: Vec<f32>,
    hue: Vec<f32>,
    energy: Vec<f32>,
    cohesion_gene: Vec<f32>,
    best_parent: Vec<i32>,
    genomes: Vec<f32>,
    bin_share: [f32; HUE_BINS],
    dominant_bin: usize,
    extinction_bin: i32,
    species: usize,
    churn_cursor: usize,
    frame: u32,
    births: u32,
    bounds: f32,
    params: SimParams,
    field: [f32; FIELD_SIZE],
    positions: Vec<f32>,
    velocities: Vec<f32>,
    // Flat uniform grid (counting sort): cell_start[c]..cell_start[c+1] indexes cell_items.
    grid_dim: usize,
    grid_reach: usize,
    grid_cell: f32,
    grid_origin: f32,
    cell_start: Vec<u32>,
    cell_cursor: Vec<u32>,
    cell_items: Vec<u32>,
    /// Upper bound on neighbours evaluated per bird; denser neighbourhoods are stride-sampled.
    max_neighbors: usize,
    /// Frames between cache-locality reorders (0 disables).
    reorder_interval: u32,
    rng_state: u32,
}

#[wasm_bindgen]
impl FlockSim {
    #[wasm_bindgen(constructor)]
    pub fn new(count: usize, bounds: f32, params: SimParams) -> FlockSim {
        let mut field = [0.0_f32; FIELD_SIZE];
        field[15] = 1.0; // vortex axis y
        field[28] = 1.0; // shape axis y
        field[77] = 1.0; // containment scale x
        field[78] = 1.0; // containment scale y
        field[79] = 1.0; // containment scale z

        let mut sim = FlockSim {
            pos_x: Vec::with_capacity(count),
            pos_y: Vec::with_capacity(count),
            pos_z: Vec::with_capacity(count),
            vel_x: Vec::with_capacity(count),
            vel_y: Vec::with_capacity(count),
            vel_z: Vec::with_capacity(count),
            step_out: vec![BirdOut::default(); count],
            perm_tmp: Vec::new(),
            traits: Vec::with_capacity(count),
            hue: Vec::with_capacity(count),
            energy: Vec::with_capacity(count),
            cohesion_gene: Vec::with_capacity(count),
            best_parent: vec![-1; count],
            genomes: vec![0.0; count * 2],
            bin_share: [1.0 / HUE_BINS as f32; HUE_BINS],
            dominant_bin: 0,
            extinction_bin: -1,
            species: HUE_BINS,
            churn_cursor: 0,
            frame: 0,
            births: 0,
            bounds,
            field,
            positions: vec![0.0; count * 3],
            velocities: vec![0.0; count * 3],
            grid_dim: 1,
            grid_reach: 1,
            grid_cell: 1.0,
            grid_origin: 0.0,
            cell_start: Vec::new(),
            cell_cursor: Vec::new(),
            cell_items: Vec::new(),
            max_neighbors: 64,
            reorder_interval: 8,
            params,
            rng_state: 0x9E37_79B9,
        };

        sim.configure_grid();
        sim.initialize_boids(count);
        sim
    }

    pub fn set_params(&mut self, params: SimParams) {
        self.params = params;
        self.configure_grid();
    }

    /// Cap on neighbours sampled per bird per step. Cost is O(count * cap)
    /// regardless of how tightly the flock packs.
    pub fn set_max_neighbors(&mut self, n: usize) {
        self.max_neighbors = n.clamp(4, 512);
    }

    pub fn max_neighbors(&self) -> usize {
        self.max_neighbors
    }

    /// Frames between memory reorders by grid cell (0 disables; debugging aid).
    pub fn set_reorder_interval(&mut self, frames: u32) {
        self.reorder_interval = frames;
    }

    /// Copy the shared force-field buffer (see FieldLayout.js). Shorter inputs
    /// only overwrite the leading entries; longer inputs are truncated.
    pub fn set_field(&mut self, data: &[f32]) {
        let n = data.len().min(FIELD_SIZE);
        self.field[..n].copy_from_slice(&data[..n]);
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
            self.traits.reserve(new_count - current);

            for _ in current..new_count {
                let n = self.pos_x.len();
                if n == 0 {
                    let (px, py, pz, vx, vy, vz) = self.make_random_boid();
                    self.pos_x.push(px);
                    self.pos_y.push(py);
                    self.pos_z.push(pz);
                    self.vel_x.push(vx);
                    self.vel_y.push(vy);
                    self.vel_z.push(vz);
                    self.traits.push(Self::random_trait());
                    self.hue.push(Self::spatial_hue(px, py, pz));
                    self.energy.push(0.35 + Math::random() as f32 * 0.3);
                    self.cohesion_gene.push(0.8 + Math::random() as f32 * 0.4);
                } else {
                    // Grow the flock from within: new birds hatch beside an
                    // existing one so count changes never scatter the shape.
                    let p = ((self.next_random() * n as f32) as usize).min(n - 1);
                    let (gx, gy, gz) = (self.gauss(), self.gauss(), self.gauss());
                    let (hx, hy, hz) = (self.gauss(), self.gauss(), self.gauss());
                    self.pos_x.push(self.pos_x[p] + gx * 3.0);
                    self.pos_y.push(self.pos_y[p] + gy * 3.0);
                    self.pos_z.push(self.pos_z[p] + gz * 3.0);
                    self.vel_x.push(self.vel_x[p] + hx * 0.3);
                    self.vel_y.push(self.vel_y[p] + hy * 0.3);
                    self.vel_z.push(self.vel_z[p] + hz * 0.3);
                    self.traits.push(self.traits[p]);
                    self.hue.push(self.hue[p]);
                    self.energy.push(0.4);
                    self.cohesion_gene.push(self.cohesion_gene[p]);
                }
            }
        } else {
            self.pos_x.truncate(new_count);
            self.pos_y.truncate(new_count);
            self.pos_z.truncate(new_count);
            self.vel_x.truncate(new_count);
            self.vel_y.truncate(new_count);
            self.vel_z.truncate(new_count);
            self.traits.truncate(new_count);
            self.hue.truncate(new_count);
            self.energy.truncate(new_count);
            self.cohesion_gene.truncate(new_count);
        }

        self.positions.resize(new_count * 3, 0.0);
        self.velocities.resize(new_count * 3, 0.0);
        self.genomes.resize(new_count * 2, 0.0);
        self.best_parent.resize(new_count, -1);
        self.step_out.resize(new_count, BirdOut::default());
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
        // Keep birds that share a cell adjacent in memory so the neighbour
        // loop streams through cache lines instead of chasing random indices.
        if self.reorder_interval > 0 && self.frame % self.reorder_interval == 0 {
            self.reorder_by_cell();
        }

        let vis_sq = self.params.visual_range * self.params.visual_range;
        let protected_sq = self.params.protected_range * self.params.protected_range;
        let avoid_factor = self.params.avoid_factor;
        let matching_factor = self.params.matching_factor;
        let centering_factor = self.params.centering_factor;
        let jitter = self.field[60];
        let max_speed = self.params.max_speed.max(0.1);

        let evo_on = self.field[64] > 0.5;
        let kinship = self.field[65].clamp(0.0, 1.0);
        let xeno = self.field[66];
        let energy_gain = self.field[69];
        let energy_loss = self.field[70];
        let extinction = self.field[71];
        let crowd_cap = self.field[73].max(1.0);

        // An extinction pulse targets the lineage that was dominant when it began.
        if extinction > 0.0 {
            if self.extinction_bin < 0 {
                self.extinction_bin = self.dominant_bin as i32;
            }
        } else {
            self.extinction_bin = -1;
        }
        let extinction_bin = self.extinction_bin;

        self.frame = self.frame.wrapping_add(1);
        if self.frame % 30 == 0 {
            self.update_hue_histogram();
        }

        let boid_count = self.count();
        if self.step_out.len() != boid_count {
            self.step_out.resize(boid_count, BirdOut::default());
        }
        if self.traits.len() != boid_count {
            self.traits.resize(boid_count, 1.0);
        }
        if self.hue.len() != boid_count {
            self.hue.resize(boid_count, 0.0);
            self.energy.resize(boid_count, 0.5);
            self.cohesion_gene.resize(boid_count, 1.0);
        }
        if self.best_parent.len() != boid_count {
            self.best_parent.resize(boid_count, -1);
        }

        let ctx = StepCtx {
            pos_x: &self.pos_x,
            pos_y: &self.pos_y,
            pos_z: &self.pos_z,
            vel_x: &self.vel_x,
            vel_y: &self.vel_y,
            vel_z: &self.vel_z,
            hue: &self.hue,
            energy: &self.energy,
            traits: &self.traits,
            cohesion_gene: &self.cohesion_gene,
            cell_start: &self.cell_start,
            cell_items: &self.cell_items,
            bin_share: &self.bin_share,
            field: &self.field,
            grid_dim: self.grid_dim,
            reach: self.grid_reach,
            grid_origin: self.grid_origin,
            inv_cell: 1.0 / self.grid_cell,
            max_neighbors: self.max_neighbors.max(4),
            frame_phase: self.frame as usize,
            rng_seed: self.rng_state ^ self.frame.wrapping_mul(0x9E37_79B9),
            bounds: self.bounds,
            margin: self.params.margin,
            turn_factor: self.params.turn_factor,
            min_speed: self.params.min_speed,
            vis_sq,
            protected_sq,
            avoid_factor,
            matching_factor,
            centering_factor,
            jitter,
            max_speed,
            evo_on,
            kinship,
            xeno,
            energy_gain,
            energy_loss,
            extinction,
            extinction_bin,
            crowd_cap,
            damping: self.field[75].clamp(0.0, 0.2),
        };

        let step_out = &mut self.step_out;
        #[cfg(feature = "parallel")]
        {
            step_out
                .par_iter_mut()
                .enumerate()
                .with_min_len(256)
                .for_each(|(i, out)| *out = step_bird(&ctx, i));
        }
        #[cfg(not(feature = "parallel"))]
        {
            for (i, out) in step_out.iter_mut().enumerate() {
                *out = step_bird(&ctx, i);
            }
        }
        // Advance the shared RNG so jitter differs even if the frame counter wraps.
        self.next_random();

        self.integrate_velocities_and_positions(boid_count);
        if evo_on {
            self.reproduce(boid_count);
        }
        self.write_positions();
    }

    pub fn genomes_ptr(&self) -> *const f32 {
        self.genomes.as_ptr()
    }

    pub fn genomes_len(&self) -> usize {
        self.genomes.len()
    }

    pub fn genomes(&self) -> Vec<f32> {
        self.genomes.clone()
    }

    /// Number of hue bins holding at least 3% of the population.
    pub fn species_count(&self) -> usize {
        self.species
    }

    pub fn dominant_hue(&self) -> f32 {
        (self.dominant_bin as f32 + 0.5) / HUE_BINS as f32
    }

    /// Total divisions so far (for stats / debugging).
    pub fn births(&self) -> u32 {
        self.births
    }

    pub fn dominant_share(&self) -> f32 {
        self.bin_share[self.dominant_bin]
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

    pub fn velocities_ptr(&self) -> *const f32 {
        self.velocities.as_ptr()
    }

    pub fn velocities_len(&self) -> usize {
        self.velocities.len()
    }

    pub fn velocities(&self) -> Vec<f32> {
        self.velocities.clone()
    }

    pub fn simd_enabled(&self) -> bool {
        cfg!(all(target_arch = "wasm32", target_feature = "simd128"))
    }

    /// True for the `parallel` build (rayon thread pool over the bird loop).
    pub fn threads_enabled(&self) -> bool {
        cfg!(feature = "parallel")
    }

    pub fn thread_count(&self) -> usize {
        #[cfg(feature = "parallel")]
        {
            rayon::current_num_threads()
        }
        #[cfg(not(feature = "parallel"))]
        {
            1
        }
    }
}

/// Per-bird result of one step; applied after the (possibly parallel) loop.
#[derive(Clone, Copy, Default)]
struct BirdOut {
    vx: f32,
    vy: f32,
    vz: f32,
    energy: f32,
    parent: i32,
}

/// Read-only view of the simulation for one step. Only shared references,
/// so it is `Sync` and the bird loop can run across rayon workers.
struct StepCtx<'a> {
    pos_x: &'a [f32],
    pos_y: &'a [f32],
    pos_z: &'a [f32],
    vel_x: &'a [f32],
    vel_y: &'a [f32],
    vel_z: &'a [f32],
    hue: &'a [f32],
    energy: &'a [f32],
    traits: &'a [f32],
    cohesion_gene: &'a [f32],
    cell_start: &'a [u32],
    cell_items: &'a [u32],
    bin_share: &'a [f32; HUE_BINS],
    field: &'a [f32; FIELD_SIZE],
    grid_dim: usize,
    reach: usize,
    grid_origin: f32,
    inv_cell: f32,
    max_neighbors: usize,
    frame_phase: usize,
    rng_seed: u32,
    bounds: f32,
    margin: f32,
    turn_factor: f32,
    min_speed: f32,
    vis_sq: f32,
    protected_sq: f32,
    avoid_factor: f32,
    matching_factor: f32,
    centering_factor: f32,
    jitter: f32,
    max_speed: f32,
    evo_on: bool,
    kinship: f32,
    xeno: f32,
    energy_gain: f32,
    energy_loss: f32,
    extinction: f32,
    extinction_bin: i32,
    crowd_cap: f32,
    damping: f32,
}

#[inline]
fn grid_coords(ctx: &StepCtx, x: f32, y: f32, z: f32) -> (usize, usize, usize) {
    let d = (ctx.grid_dim - 1) as f32;
    let cx = ((x - ctx.grid_origin) * ctx.inv_cell).floor().clamp(0.0, d) as usize;
    let cy = ((y - ctx.grid_origin) * ctx.inv_cell).floor().clamp(0.0, d) as usize;
    let cz = ((z - ctx.grid_origin) * ctx.inv_cell).floor().clamp(0.0, d) as usize;
    (cx, cy, cz)
}

/// Stateless per-bird, per-frame random in [0, 1): a hashed xorshift so
/// jitter needs no shared mutable RNG across threads.
#[inline]
fn hash_random(seed: u32, i: usize, lane: u32) -> f32 {
    let mut x = seed ^ (i as u32).wrapping_mul(0x9E37_79B9) ^ lane.wrapping_mul(0x85EB_CA6B);
    x ^= x >> 16;
    x = x.wrapping_mul(0x7FEB_352D);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846C_A68B);
    x ^= x >> 16;
    (x as f32) / (u32::MAX as f32)
}

#[inline]
fn hue_bin_of(h: f32) -> usize {
    let frac = ((h % 1.0) + 1.0) % 1.0;
    ((frac * HUE_BINS as f32) as usize).min(HUE_BINS - 1)
}

/// One bird's flocking, evolution, field and speed-envelope update.
fn step_bird(ctx: &StepCtx, i: usize) -> BirdOut {
    let px = ctx.pos_x[i];
    let py = ctx.pos_y[i];
    let pz = ctx.pos_z[i];
    let grid_dim = ctx.grid_dim;
    let reach = ctx.reach;
    let cell_start = ctx.cell_start;
    let cell_items = ctx.cell_items;

    // Block of cells within reach of the bird; z is the innermost index so
    // each (x, y) row of cells is one contiguous slice of cell_items.
    let (cx, cy, cz) = grid_coords(ctx, px, py, pz);
    let x0 = cx.saturating_sub(reach);
    let x1 = (cx + reach).min(grid_dim - 1);
    let y0 = cy.saturating_sub(reach);
    let y1 = (cy + reach).min(grid_dim - 1);
    let z0 = cz.saturating_sub(reach);
    let z1 = (cz + reach).min(grid_dim - 1);

    let mut total = 0usize;
    for gx in x0..=x1 {
        for gy in y0..=y1 {
            let row = (gx * grid_dim + gy) * grid_dim;
            total += (cell_start[row + z1 + 1] - cell_start[row + z0]) as usize;
        }
    }
    // Dense neighbourhoods are stride-sampled so cost stays O(max_neighbors)
    // per bird; summed terms are rescaled by the stride below.
    let stride = ((total + ctx.max_neighbors - 1) / ctx.max_neighbors).max(1);
    let phase = (i + ctx.frame_phase) % stride;
    let sample_scale = stride as f32;
    let mut k = 0usize;

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
    let mut weight_sum = 0.0_f32;
    let mut xeno_x = 0.0_f32;
    let mut xeno_y = 0.0_f32;
    let mut xeno_z = 0.0_f32;
    let mut best_parent: i32 = -1;
    let mut best_energy = 0.0_f32;
    let hue_i = ctx.hue[i];
    let kinship = ctx.kinship;
    let xeno = ctx.xeno;

    for gx in x0..=x1 {
        for gy in y0..=y1 {
            let row = (gx * grid_dim + gy) * grid_dim;
            let s = cell_start[row + z0] as usize;
            let e = cell_start[row + z1 + 1] as usize;
            // First slot in this slice whose global ordinal k matches the phase,
            // then jump by the stride: O(max_neighbors) work however dense the cell.
            let mut j = s + (phase + stride - (k % stride)) % stride;
            k += e - s;
            while j < e {
                let n_idx = cell_items[j] as usize;
                j += stride;
                if n_idx == i {
                    continue;
                }

                let dx = px - ctx.pos_x[n_idx];
                let dy = py - ctx.pos_y[n_idx];
                let dz = pz - ctx.pos_z[n_idx];
                let dist_sq = dx * dx + dy * dy + dz * dz;

                if dist_sq < ctx.protected_sq && dist_sq > 0.0 {
                    close_x += dx;
                    close_y += dy;
                    close_z += dz;
                }

                if dist_sq < ctx.vis_sq {
                    // kinship: 1 for identical lineage hue, 0 for opposite hue
                    let mut dh = (hue_i - ctx.hue[n_idx]).abs();
                    if dh > 0.5 {
                        dh = 1.0 - dh;
                    }
                    let kin = 1.0 - 2.0 * dh;
                    let w = 1.0 - kinship + kinship * kin;

                    avg_vx += ctx.vel_x[n_idx] * w;
                    avg_vy += ctx.vel_y[n_idx] * w;
                    avg_vz += ctx.vel_z[n_idx] * w;
                    avg_px += ctx.pos_x[n_idx] * w;
                    avg_py += ctx.pos_y[n_idx] * w;
                    avg_pz += ctx.pos_z[n_idx] * w;
                    weight_sum += w;
                    count += 1.0;

                    if xeno > 0.0 && kin < 0.5 && dist_sq > 0.0 {
                        let inv = 1.0 / (dist_sq.sqrt() + 1e-3);
                        let push = (0.5 - kin) * 2.0 * inv;
                        xeno_x += dx * push;
                        xeno_y += dy * push;
                        xeno_z += dz * push;
                    }

                    let e = ctx.energy[n_idx];
                    if e > best_energy {
                        best_energy = e;
                        best_parent = n_idx as i32;
                    }
                }
            }
        }
    }

    close_x *= sample_scale;
    close_y *= sample_scale;
    close_z *= sample_scale;
    xeno_x *= sample_scale;
    xeno_y *= sample_scale;
    xeno_z *= sample_scale;
    count *= sample_scale;

    let mut vx = ctx.vel_x[i] + close_x * ctx.avoid_factor + xeno_x * xeno;
    let mut vy = ctx.vel_y[i] + close_y * ctx.avoid_factor + xeno_y * xeno;
    let mut vz = ctx.vel_z[i] + close_z * ctx.avoid_factor + xeno_z * xeno;

    let mut coherence = 0.0_f32;
    if weight_sum > 1e-6 {
        let inv = 1.0 / weight_sum;
        avg_vx *= inv;
        avg_vy *= inv;
        avg_vz *= inv;
        avg_px *= inv;
        avg_py *= inv;
        avg_pz *= inv;

        vx += (avg_vx - vx) * ctx.matching_factor;
        vy += (avg_vy - vy) * ctx.matching_factor;
        vz += (avg_vz - vz) * ctx.matching_factor;

        let cg = ctx.centering_factor * ctx.cohesion_gene[i];
        vx += (avg_px - px) * cg;
        vy += (avg_py - py) * cg;
        vz += (avg_pz - pz) * cg;

        coherence = ((avg_vx * avg_vx + avg_vy * avg_vy + avg_vz * avg_vz).sqrt() / ctx.max_speed)
            .clamp(0.0, 1.0);
    }

    let mut energy = ctx.energy[i];
    if ctx.evo_on {
        // Energy economy: company and coherence feed a bird, speed and
        // crowding cost it, rare lineages get a bonus so diversity survives.
        // Logistic gain against energy-proportional decay: energy settles at
        // gain / (gain + loss), so only isolated or incoherent birds starve.
        let bin = hue_bin_of(hue_i);
        let rarity = (1.15 - ctx.bin_share[bin]).clamp(0.6, 1.15);
        let company = (count / 3.0).min(1.0);
        let crowd = count / ctx.crowd_cap;
        let speed = (vx * vx + vy * vy + vz * vz).sqrt() / ctx.max_speed;
        let e_i = energy;
        let gain = ctx.energy_gain * company * (0.4 + 0.6 * coherence) * rarity * (1.0 - e_i);
        let mut loss = ctx.energy_loss * (0.5 + 0.5 * speed) * e_i;
        if crowd > 1.0 {
            loss += ctx.energy_loss * (crowd - 1.0) * 1.5 * e_i;
        }
        if ctx.extinction > 0.0 && bin as i32 == ctx.extinction_bin {
            loss += ctx.extinction * 0.02;
        }
        energy = (e_i + gain - loss).clamp(0.0, 1.0);
    }

    let trait_v = ctx.traits[i];
    let (fx, fy, fz) = apply_field(ctx.field, px, py, pz, vx, vy, vz, trait_v, hue_i);
    vx += fx;
    vy += fy;
    vz += fz;
    // Drift: momentum carries but decays, like floating in still water.
    if ctx.damping > 0.0 {
        let keep = 1.0 - ctx.damping;
        vx *= keep;
        vy *= keep;
        vz *= keep;
    }

    if ctx.jitter > 0.0 {
        vx += (hash_random(ctx.rng_seed, i, 1) - 0.5) * ctx.jitter;
        vy += (hash_random(ctx.rng_seed, i, 2) - 0.5) * ctx.jitter;
        vz += (hash_random(ctx.rng_seed, i, 3) - 0.5) * ctx.jitter;
    }

    // Boundary turn-back.
    let b = ctx.bounds;
    let m = ctx.margin;
    let t = ctx.turn_factor;
    if px < -b + m {
        vx += t;
    } else if px > b - m {
        vx -= t;
    }
    if py < -b + m {
        vy += t;
    } else if py > b - m {
        vy -= t;
    }
    if pz < -b + m {
        vz += t;
    } else if pz > b - m {
        vz -= t;
    }

    // Personality nudges the speed envelope so the flock is not perfectly uniform.
    let min_speed = ctx.min_speed * (0.85 + (trait_v - 1.0) * 0.5);
    let max_speed = ctx.max_speed * (0.9 + (trait_v - 1.0) * 0.6);
    let speed = (vx * vx + vy * vy + vz * vz).sqrt();
    if speed > 0.0 && speed < min_speed {
        let scale = min_speed / speed;
        vx *= scale;
        vy *= scale;
        vz *= scale;
    } else if speed > max_speed {
        let scale = max_speed / speed;
        vx *= scale;
        vy *= scale;
        vz *= scale;
    }

    BirdOut {
        vx,
        vy,
        vz,
        energy,
        parent: best_parent,
    }
}

/// Force-field evaluation. Mirrors `applyField` in src/fields/FieldLayout.js
/// index-for-index; keep the two in sync.
fn apply_field(
    f: &[f32; FIELD_SIZE],
    px: f32,
    py: f32,
    pz: f32,
    vx: f32,
    vy: f32,
    vz: f32,
    trait_v: f32,
    hue: f32,
) -> (f32, f32, f32) {
    let mut ax = 0.0_f32;
    let mut ay = 0.0_f32;
    let mut az = 0.0_f32;

    // ---- Curl noise wind -------------------------------------------------
    let fs = f[0];
    if fs != 0.0 {
        let (k1x, k1y, k1z) = (f[1], f[2], f[3]);
        let (k2x, k2y, k2z) = (f[4], f[5], f[6]);
        let (k3x, k3y, k3z) = (f[7], f[8], f[9]);
        let c1 = (k1x * px + k1y * py + k1z * pz + f[10]).cos();
        let c2 = (k2x * px + k2y * py + k2z * pz + f[11]).cos();
        let c3 = (k3x * px + k3y * py + k3z * pz + f[12]).cos();
        let cx = k3y * c3 - k2z * c2;
        let cy = k1z * c1 - k3x * c3;
        let cz = k2x * c2 - k1y * c1;
        let kn = (k1x * k1x + k1y * k1y + k1z * k1z).sqrt() + 1e-6;
        let s = fs / kn;
        ax += cx * s;
        ay += cy * s;
        az += cz * s;
    }

    // ---- Vortex ------------------------------------------------------------
    let vs = f[13];
    let vp = f[20];
    let vl = f[21];
    if vs != 0.0 || vp != 0.0 || vl != 0.0 {
        let (axx, axy, axz) = (f[14], f[15], f[16]);
        let (qx, qy, qz) = (px - f[17], py - f[18], pz - f[19]);
        let along = qx * axx + qy * axy + qz * axz;
        let (rx, ry, rz) = (qx - axx * along, qy - axy * along, qz - axz * along);
        let rl = (rx * rx + ry * ry + rz * rz).sqrt() + 1e-4;
        let tx = axy * rz - axz * ry;
        let ty = axz * rx - axx * rz;
        let tz = axx * ry - axy * rx;
        let vr = f[22];
        let mut fall = 1.0_f32;
        if vr > 0.0 {
            let u = rl / vr;
            fall = u * (1.0 - u).exp();
        }
        let tangent = (vs * fall) / rl;
        ax += tx * tangent - (rx / rl) * vp;
        ay += ty * tangent - (ry / rl) * vp;
        az += tz * tangent - (rz / rl) * vp;
        ax += axx * vl;
        ay += axy * vl;
        az += axz * vl;
    }

    // ---- Shape attractor ---------------------------------------------------
    let st = f[23] as i32;
    let ss = f[24];
    if st != 0 && ss != 0.0 {
        let r1 = f[25];
        let r2 = f[26];
        let (axx, axy, axz) = (f[27], f[28], f[29]);
        let (qx, qy, qz) = (px - f[30], py - f[31], pz - f[32]);

        if st == 1 {
            let d = (qx * qx + qy * qy + qz * qz).sqrt() + 1e-4;
            let k = (ss * (r1 - d)) / d;
            ax += qx * k;
            ay += qy * k;
            az += qz * k;
        } else {
            let along = qx * axx + qy * axy + qz * axz;
            let (rx, ry, rz) = (qx - axx * along, qy - axy * along, qz - axz * along);
            let rl = (rx * rx + ry * ry + rz * rz).sqrt() + 1e-4;

            if st == 2 {
                let ring_scale = r1 / rl;
                let dx = qx - rx * ring_scale;
                let dy = qy - ry * ring_scale;
                let dz = qz - rz * ring_scale;
                let d = (dx * dx + dy * dy + dz * dz).sqrt() + 1e-4;
                let k = (ss * (r2 - d)) / d;
                ax += dx * k;
                ay += dy * k;
                az += dz * k;
            } else if st == 3 {
                let k_plane = -ss * along;
                ax += axx * k_plane;
                ay += axy * k_plane;
                az += axz * k_plane;
                if rl > r1 {
                    let k = (ss * 0.6 * (r1 - rl)) / rl;
                    ax += rx * k;
                    ay += ry * k;
                    az += rz * k;
                }
            } else if st == 4 {
                let k = (ss * (r1 - rl)) / rl;
                ax += rx * k;
                ay += ry * k;
                az += rz * k;
                if along > r2 {
                    let kk = -ss * 0.8 * (along - r2);
                    ax += axx * kk;
                    ay += axy * kk;
                    az += axz * kk;
                } else if along < -r2 {
                    let kk = -ss * 0.8 * (along + r2);
                    ax += axx * kk;
                    ay += axy * kk;
                    az += axz * kk;
                }
            } else if st == 5 {
                let (sx, sy, sz) = (rx / r1, ry / r1, rz / r1);
                let sa = along / r2.max(1e-3);
                let e = (sx * sx + sy * sy + sz * sz + sa * sa).sqrt() + 1e-4;
                let k = ss * (1.0 - e) * r1;
                let inv = 1.0 / e;
                ax += (rx * inv / r1 + axx * sa * inv) * k;
                ay += (ry * inv / r1 + axy * sa * inv) * k;
                az += (rz * inv / r1 + axz * sa * inv) * k;
            }
        }
    }

    // ---- Agents ------------------------------------------------------------
    let agent_count = (f[33] as i32).clamp(0, 3) as usize;
    for i in 0..agent_count {
        let b = 34 + i * 5;
        let (dx, dy, dz) = (px - f[b], py - f[b + 1], pz - f[b + 2]);
        let strength = f[b + 3];
        let radius = f[b + 4];
        if strength == 0.0 || radius <= 0.0 {
            continue;
        }
        let d = (dx * dx + dy * dy + dz * dz).sqrt() + 1e-4;
        if strength > 0.0 {
            if d < radius {
                let u = 1.0 - d / radius;
                let k = (strength * u * u) / d;
                ax += dx * k;
                ay += dy * k;
                az += dz * k;
            }
        } else {
            let u = d / radius;
            let w = if u < 1.0 { u } else { 1.0 / (u * u) };
            let k = (strength * w) / d;
            ax += dx * k;
            ay += dy * k;
            az += dz * k;
        }
    }

    // ---- Pulse ---------------------------------------------------------------
    let ps = f[49];
    if ps != 0.0 {
        let (dx, dy, dz) = (px - f[52], py - f[53], pz - f[54]);
        let d = (dx * dx + dy * dy + dz * dz).sqrt() + 1e-4;
        let w = f[51].max(1.0);
        let g = (d - f[50]) / w;
        let band = (-g * g).exp();
        let k = (ps * band) / d;
        ax += dx * k;
        ay += dy * k;
        az += dz * k;
    }

    // ---- Wind ------------------------------------------------------------------
    ax += f[55];
    ay += f[56];
    az += f[57];

    // ---- Cymatic layers -------------------------------------------------
    let cn = f[80] as i32;
    if cn > 0 {
        let aff = f[141];
        let band = (((hue % 1.0) + 1.0) % 1.0 * 4.0) as i32 & 3;
        for i in 0..cn.min(5) as usize {
            let b = 81 + i * 12;
            let mut s = f[b];
            if s == 0.0 {
                continue;
            }
            if aff > 0.0 {
                s *= if band == f[b + 10] as i32 {
                    1.0 + aff
                } else {
                    1.0 - 0.7 * aff
                };
            }
            let (kx, ky, kz) = (f[b + 1], f[b + 2], f[b + 3]);
            let (k2x, k2y, k2z) = (f[b + 4], f[b + 5], f[b + 6]);
            let u = kx * px + ky * py + kz * pz + f[b + 7];
            let v = k2x * px + k2y * py + k2z * pz + f[b + 8];
            let (s1, c1) = u.sin_cos();
            let (s2, c2) = v.sin_cos();
            let val = c1 * c2;
            let gx = -s1 * c2 * kx - c1 * s2 * k2x;
            let gy = -s1 * c2 * ky - c1 * s2 * k2y;
            let gz = -s1 * c2 * kz - c1 * s2 * k2z;
            let kn = (kx * kx + ky * ky + kz * kz).sqrt() + 1e-6;
            let g = (if f[b + 9] > 0.5 { s } else { -s }) * val / kn;
            ax += gx * g;
            ay += gy * g;
            az += gz * g;
            // steer: rotate cross-sheet velocity into the along-sheet direction (see FieldLayout.js)
            let gl2 = gx * gx + gy * gy + gz * gz;
            if gl2 > 1e-10 {
                let vn = (vx * gx + vy * gy + vz * gz) / gl2;
                let cd = (2.0 * s.abs()).min(0.3) * (1.0 - val * val);
                let (rx, ry, rz) = (vn * gx, vn * gy, vn * gz);
                let (tx, ty, tz) = (vx - rx, vy - ry, vz - rz);
                let tl = (tx * tx + ty * ty + tz * tz).sqrt();
                let rl = (rx * rx + ry * ry + rz * rz).sqrt();
                ax -= rx * cd;
                ay -= ry * cd;
                az -= rz * cd;
                if tl > 1e-4 {
                    let add = rl * cd / tl;
                    ax += tx * add;
                    ay += ty * add;
                    az += tz * add;
                }
            }
        }
    }

    // ---- Shear ------------------------------------------------------------
    let shs = f[142];
    if shs != 0.0 {
        let d = px * f[143] + py * f[144] + pz * f[145];
        let k = shs * (d / 60.0).clamp(-1.5, 1.5);
        ax += f[146] * k;
        ay += f[147] * k;
        az += f[148] * k;
    }

    // ---- Containment ------------------------------------------------------
    let cs = f[58];
    if cs != 0.0 {
        let cr = f[59];
        let ct = f[76] as i32;
        if ct == 1 {
            let (rx, ry, rz) = (cr * f[77], cr * f[78], cr * f[79]);
            let (ex, ey, ez) = (px / rx, py / ry, pz / rz);
            let e = (ex * ex + ey * ey + ez * ez).sqrt() + 1e-4;
            if e > 1.0 {
                let k = -cs * (e - 1.0) / e;
                let cr2 = cr * cr;
                ax += px * (cr2 / (rx * rx)) * k;
                ay += py * (cr2 / (ry * ry)) * k;
                az += pz * (cr2 / (rz * rz)) * k;
            }
        } else if ct == 2 {
            // rounded box (see FieldLayout.js)
            let r = 0.35 * (cr * f[77]).min(cr * f[78]).min(cr * f[79]);
            let (hx, hy, hz) = (cr * f[77] - r, cr * f[78] - r, cr * f[79] - r);
            let excess = |p: f32, h: f32| {
                if p > h {
                    p - h
                } else if p < -h {
                    p + h
                } else {
                    0.0
                }
            };
            let (ex, ey, ez) = (excess(px, hx), excess(py, hy), excess(pz, hz));
            let el = (ex * ex + ey * ey + ez * ez).sqrt();
            if el > r {
                let k = -cs * (el - r) / el;
                ax += ex * k;
                ay += ey * k;
                az += ez * k;
            }
        } else {
            let d = (px * px + py * py + pz * pz).sqrt() + 1e-4;
            if d > cr {
                let k = -cs * (d - cr) / d;
                ax += px * k;
                ay += py * k;
                az += pz * k;
            }
        }
    }

    // ---- Personality ---------------------------------------------------------
    let spread = f[61];
    let m = 1.0 + (trait_v - 1.0) * spread;
    (ax * m, ay * m, az * m)
}

impl FlockSim {
    fn random_trait() -> f32 {
        0.7 + Math::random() as f32 * 0.6
    }

    /// Initial lineages are spatial: six angular sectors around the vertical
    /// axis each seed one hue, so colour domains are contiguous from the start.
    fn spatial_hue(px: f32, _py: f32, pz: f32) -> f32 {
        let sectors = 6.0;
        let angle = pz.atan2(px).rem_euclid(std::f32::consts::TAU);
        let sector = (angle / std::f32::consts::TAU * sectors).floor();
        ((sector + 0.5) / sectors + 1.0 / 32.0).rem_euclid(1.0)
    }

    fn hue_bin(h: f32) -> usize {
        ((h.rem_euclid(1.0) * HUE_BINS as f32) as usize).min(HUE_BINS - 1)
    }

    fn update_hue_histogram(&mut self) {
        let mut counts = [0.0_f32; HUE_BINS];
        for &h in &self.hue {
            counts[Self::hue_bin(h)] += 1.0;
        }
        let total = self.hue.len().max(1) as f32;
        let mut dominant = 0;
        let mut species = 0;
        for b in 0..HUE_BINS {
            self.bin_share[b] = counts[b] / total;
            if self.bin_share[b] > self.bin_share[dominant] {
                dominant = b;
            }
            if self.bin_share[b] >= 0.03 {
                species += 1;
            }
        }
        self.dominant_bin = dominant;
        self.species = species;
    }

    fn gauss(&mut self) -> f32 {
        self.next_random() + self.next_random() + self.next_random() - 1.5
    }

    /// Death and division: a sliding window of birds is checked each frame;
    /// starving birds are replaced by a mutated copy of their best-fed
    /// neighbour (spawned beside it), or by a fresh random mutant.
    fn reproduce(&mut self, boid_count: usize) {
        if boid_count == 0 {
            return;
        }
        let churn = self.field[68].clamp(0.0, 1.0);
        let mutation = self.field[67].max(0.0);
        let death = self.field[72];
        let senescence = self.field[74].max(0.0);
        let window = ((boid_count as f32 * churn).ceil() as usize).clamp(1, boid_count);

        for k in 0..window {
            let j = (self.churn_cursor + k) % boid_count;
            if self.energy[j] >= death && self.next_random() >= senescence {
                continue;
            }
            let parent = self.best_parent[j];
            let parent_ok =
                parent >= 0 && (parent as usize) < boid_count && self.energy[parent as usize] > 0.3;
            if !parent_ok && self.next_random() > 0.005 {
                continue; // no fit neighbour yet: linger, most of the time
            }
            if parent_ok {
                let p = parent as usize;
                self.pos_x[j] = self.pos_x[p] + self.gauss() * 2.5;
                self.pos_y[j] = self.pos_y[p] + self.gauss() * 2.5;
                self.pos_z[j] = self.pos_z[p] + self.gauss() * 2.5;
                self.vel_x[j] = self.vel_x[p] + self.gauss() * 0.3;
                self.vel_y[j] = self.vel_y[p] + self.gauss() * 0.3;
                self.vel_z[j] = self.vel_z[p] + self.gauss() * 0.3;
                // Lineage hue is inherited exactly; rare speciation jumps found a
                // new, visibly distinct daughter lineage.
                self.hue[j] = if self.next_random() < mutation * 0.15 {
                    let jump = 0.05 + self.next_random() * 0.08;
                    let dir = if self.next_random() < 0.5 { -1.0 } else { 1.0 };
                    (self.hue[p] + dir * jump).rem_euclid(1.0)
                } else {
                    self.hue[p]
                };
                self.traits[j] = (self.traits[p] + self.gauss() * mutation * 2.0).clamp(0.6, 1.4);
                self.cohesion_gene[j] =
                    (self.cohesion_gene[p] + self.gauss() * mutation * 4.0).clamp(0.4, 1.8);
                self.energy[j] = 0.35;
                self.energy[p] -= 0.1;
                self.births += 1;
            } else {
                // random spawn: a brand-new mutant lineage keeps the gene pool fresh
                self.hue[j] = self.next_random();
                self.traits[j] = 0.7 + self.next_random() * 0.6;
                self.cohesion_gene[j] = 0.8 + self.next_random() * 0.4;
                self.energy[j] = 0.3;
            }
        }
        self.churn_cursor = (self.churn_cursor + window) % boid_count;
    }

    /// xorshift32: cheap per-bird jitter without crossing into JS each call.
    fn next_random(&mut self) -> f32 {
        let mut x = self.rng_state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng_state = x;
        (x as f32) / (u32::MAX as f32)
    }

    fn initialize_boids(&mut self, count: usize) {
        self.pos_x.clear();
        self.pos_y.clear();
        self.pos_z.clear();
        self.vel_x.clear();
        self.vel_y.clear();
        self.vel_z.clear();
        self.traits.clear();
        self.hue.clear();
        self.energy.clear();
        self.cohesion_gene.clear();

        self.pos_x.reserve(count);
        self.pos_y.reserve(count);
        self.pos_z.reserve(count);
        self.vel_x.reserve(count);
        self.vel_y.reserve(count);
        self.vel_z.reserve(count);
        self.traits.reserve(count);

        for _ in 0..count {
            let (px, py, pz, vx, vy, vz) = self.make_random_boid();
            self.pos_x.push(px);
            self.pos_y.push(py);
            self.pos_z.push(pz);
            self.vel_x.push(vx);
            self.vel_y.push(vy);
            self.vel_z.push(vz);
            self.traits.push(Self::random_trait());
            self.hue.push(Self::spatial_hue(px, py, pz));
            self.energy.push(0.35 + Math::random() as f32 * 0.3);
            self.cohesion_gene.push(0.8 + Math::random() as f32 * 0.4);
        }

        self.best_parent.resize(count, -1);
        self.genomes.resize(count * 2, 0.0);
        self.bin_share = [1.0 / HUE_BINS as f32; HUE_BINS];
        self.update_hue_histogram();
        self.step_out.resize(count, BirdOut::default());
        self.positions.resize(count * 3, 0.0);
        self.velocities.resize(count * 3, 0.0);
        self.write_positions();
    }

    fn write_positions(&mut self) {
        for idx in 0..self.count() {
            let out = idx * 3;
            self.positions[out] = self.pos_x[idx];
            self.positions[out + 1] = self.pos_y[idx];
            self.positions[out + 2] = self.pos_z[idx];
            self.velocities[out] = self.vel_x[idx];
            self.velocities[out + 1] = self.vel_y[idx];
            self.velocities[out + 2] = self.vel_z[idx];
            self.genomes[idx * 2] = self.hue[idx];
            self.genomes[idx * 2 + 1] = self.energy[idx];
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

    /// Size the flat grid for the current visual range. Cells match the
    /// visual range (a 3x3x3 block covers every neighbour); when the world is
    /// too large for the cell budget, cells grow and `grid_reach` stays 1.
    /// Half-size cells with a 5x5x5 block were measured ~2x slower for no
    /// visible gain, so the cell stays at full visual range.
    fn configure_grid(&mut self) {
        let extent = (self.bounds * 3.0).max(1.0);
        let max_dim = 64.0_f32;
        let vr = self.params.visual_range.max(1.0);
        let cell = vr.max(extent / max_dim);
        self.grid_cell = cell;
        self.grid_origin = -self.bounds * 1.5;
        self.grid_reach = ((vr / cell).ceil() as usize).max(1);
        self.grid_dim = ((extent / cell).ceil() as usize).clamp(1, max_dim as usize);
        let cells = self.grid_dim * self.grid_dim * self.grid_dim;
        self.cell_start.resize(cells + 1, 0);
        self.cell_cursor.resize(cells + 1, 0);
    }

    #[inline]
    fn cell_coords(&self, x: f32, y: f32, z: f32) -> (usize, usize, usize) {
        let d = (self.grid_dim - 1) as f32;
        let inv = 1.0 / self.grid_cell;
        let cx = ((x - self.grid_origin) * inv).floor().clamp(0.0, d) as usize;
        let cy = ((y - self.grid_origin) * inv).floor().clamp(0.0, d) as usize;
        let cz = ((z - self.grid_origin) * inv).floor().clamp(0.0, d) as usize;
        (cx, cy, cz)
    }

    /// Permute every per-bird array into grid order (cell_items), then the
    /// grid is trivially identity-sorted. best_parent indices are invalidated;
    /// they are recomputed every step before use.
    fn reorder_by_cell(&mut self) {
        let n = self.count();
        if n < 2 || self.cell_items.len() != n {
            return;
        }
        let order = std::mem::take(&mut self.cell_items);
        let mut tmp = std::mem::take(&mut self.perm_tmp);
        tmp.resize(n, 0.0);
        {
            let mut permute = |arr: &mut Vec<f32>| {
                for (slot, &src) in order.iter().enumerate() {
                    tmp[slot] = arr[src as usize];
                }
                arr.copy_from_slice(&tmp[..n]);
            };
            permute(&mut self.pos_x);
            permute(&mut self.pos_y);
            permute(&mut self.pos_z);
            permute(&mut self.vel_x);
            permute(&mut self.vel_y);
            permute(&mut self.vel_z);
            permute(&mut self.traits);
            permute(&mut self.hue);
            permute(&mut self.energy);
            permute(&mut self.cohesion_gene);
        }
        self.perm_tmp = tmp;
        for v in self.best_parent.iter_mut() {
            *v = -1;
        }
        self.cell_items = order;
        for (slot, v) in self.cell_items.iter_mut().enumerate() {
            *v = slot as u32;
        }
    }

    /// Counting sort of bird indices into cells. No hashing, no per-cell Vecs.
    fn rebuild_spatial_grid(&mut self) {
        let n = self.count();
        let dim = self.grid_dim;
        let cells = dim * dim * dim;
        if self.cell_start.len() != cells + 1 {
            self.cell_start.resize(cells + 1, 0);
            self.cell_cursor.resize(cells + 1, 0);
        }
        self.cell_items.resize(n, 0);
        for v in self.cell_start.iter_mut() {
            *v = 0;
        }
        for i in 0..n {
            let (cx, cy, cz) = self.cell_coords(self.pos_x[i], self.pos_y[i], self.pos_z[i]);
            let c = (cx * dim + cy) * dim + cz;
            self.cell_start[c + 1] += 1;
        }
        for c in 0..cells {
            self.cell_start[c + 1] += self.cell_start[c];
        }
        self.cell_cursor.copy_from_slice(&self.cell_start);
        for i in 0..n {
            let (cx, cy, cz) = self.cell_coords(self.pos_x[i], self.pos_y[i], self.pos_z[i]);
            let c = (cx * dim + cy) * dim + cz;
            let slot = self.cell_cursor[c] as usize;
            self.cell_items[slot] = i as u32;
            self.cell_cursor[c] += 1;
        }
    }

    fn integrate_velocities_and_positions(&mut self, boid_count: usize) {
        let evo_on = self.field[64] > 0.5;
        for i in 0..boid_count {
            let o = self.step_out[i];
            self.vel_x[i] = o.vx;
            self.vel_y[i] = o.vy;
            self.vel_z[i] = o.vz;
            self.pos_x[i] += o.vx;
            self.pos_y[i] += o.vy;
            self.pos_z[i] += o.vz;
            self.best_parent[i] = o.parent;
            if evo_on {
                self.energy[i] = o.energy;
            }
        }
    }
}
