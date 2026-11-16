/**
 * particleFilter.js — the estimator behind Tab 3's blue dot.
 *
 * WHY A PARTICLE FILTER
 * ---------------------
 * The obvious way to fuse sensors is to average them: take the dead-reckoning
 * guess, nudge it some fraction of the way toward the Wi-Fi fix, and clamp the
 * result into a corridor. That is what this project did first, and it has three
 * problems that matter:
 *
 *   1. It cannot represent "I might be in either of two corridors". A single
 *      averaged point always sits somewhere, even if that somewhere is a wall.
 *   2. It cannot USE the floor plan as evidence — only as a final clamp. Snapping
 *      a drifted point sideways into a corridor fixes error across the corridor
 *      and does nothing about error along it.
 *   3. It has no honest notion of its own uncertainty. There is nothing in a
 *      single point to say how sure it is.
 *
 * A particle filter fixes all three by representing position as a CLOUD of a few
 * hundred weighted guesses instead of one point:
 *
 *   - Each particle carries its own hypothesis about the sensor errors — how
 *     wrong the compass is, how long the user's stride really is.
 *   - Dead reckoning moves every particle by its own hypothesis, so the cloud
 *     spreads exactly as fast as the sensors are untrustworthy.
 *   - Map matching DELETES particles that walked through a wall. This is the
 *     powerful part: after a corner, only particles whose compass hypothesis was
 *     roughly right are still alive, so the filter learns the compass error from
 *     the building's shape without ever being told it.
 *   - A Wi-Fi scan re-weights particles by how well each one's expected
 *     fingerprint matches what was actually heard, then resamples.
 *   - The spread of the surviving cloud IS the uncertainty. It is computed from
 *     the particles alone and never looks at the true position.
 *
 * This is the standard approach in indoor positioning literature and in shipping
 * products, which is the point: the demo should show how it is really done.
 */

import { pointInAnyRect, countWallsCrossed, dist } from '../floorplan/geometry.js';
import { gaussian } from './wifi.js';

/** Tuning for the filter itself (as opposed to the sensors it consumes). */
export const PF_CONFIG = {
  /** Cloud size. A few hundred is plenty for a 2-D problem this constrained. */
  count: 400,

  /** Spread of the cloud when a QR scan pins it, in metres. */
  scanSpreadM: 0.5,

  /**
   * Spread of each particle's initial compass-error hypothesis, radians.
   * ~0.15 rad is 8.6 deg — the right order for a phone magnetometer indoors,
   * where structural steel and motors distort the field.
   */
  headingHypothesisSigma: 0.15,

  /**
   * Process noise on the compass hypothesis per step. Lets the filter track a
   * bias that changes as the user walks past different steel structures. Too
   * small and the filter cannot follow; too large and it forgets what it learnt.
   */
  headingHypothesisDrift: 0.012,

  /** Spread of each particle's stride-scale hypothesis (fraction). */
  strideHypothesisSigma: 0.07,

  /**
   * Standard deviation used in the Wi-Fi likelihood, in dB.
   *
   * Deliberately LARGER than the receiver noise (3.5 dB). The mismatch between
   * a predicted radio map and a real building is far bigger than receiver
   * noise, and a likelihood that ignores that is overconfident: it collapses the
   * whole cloud onto one reference point and the filter stops tracking. Inflating
   * the assumed noise is the standard, honest fix.
   */
  likelihoodSigmaDb: 7,

  /**
   * When to conclude the cloud is in the wrong place entirely and rebuild it.
   *
   * This is a likelihood-RATIO test, not an absolute threshold, and the
   * distinction matters. A particle filter can only re-weight hypotheses it
   * already holds: if every particle is on Level 1 and the user has just ridden
   * an escalator to Level 2, the correct answer has zero probability in the
   * cloud and no amount of re-weighting will find it. An absolute "residual >
   * N dB" trigger is fragile here — the residual depends on how many access
   * points are audible, so it needs retuning per building.
   *
   * Instead we compare the best explanation INSIDE the cloud against the best
   * explanation anywhere in the radio map. If somewhere else explains the
   * reading materially better, the cloud is simply in the wrong place. That test
   * is self-calibrating and needs no per-building tuning.
   */
  relocalizeMarginDb: 3,

  /** Resample when the effective sample size falls below this fraction. */
  resampleEssRatio: 0.5,
};

/** @typedef {{x:number,y:number,level:number,ho:number,ss:number,w:number}} Particle */

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * A cloud pinned around a known point — used at the entrance QR scan and on
 * every later re-scan.
 */
export function initParticlesAt(point, level, rng, count = PF_CONFIG.count) {
  const particles = new Array(count);
  for (let i = 0; i < count; i++) {
    particles[i] = {
      x: point.x + gaussian(rng) * PF_CONFIG.scanSpreadM,
      y: point.y + gaussian(rng) * PF_CONFIG.scanSpreadM,
      level,
      // Each particle guesses the compass is wrong by a different amount...
      ho: gaussian(rng) * PF_CONFIG.headingHypothesisSigma,
      // ...and that the user's stride differs from the assumed 0.72 m.
      ss: 1 + gaussian(rng) * PF_CONFIG.strideHypothesisSigma,
      w: 1 / count,
    };
  }
  return particles;
}

/**
 * A cloud spread uniformly over all walkable space — "I have no idea where I
 * am". This is the honest starting state when there is no QR bootstrap, and it
 * makes the value of that one entrance scan visible.
 */
export function initParticlesLost(levels, rng, count = PF_CONFIG.count) {
  const rects = [];
  for (const l of levels) {
    for (const r of l.corridors) rects.push({ ...r, level: l.level });
  }
  const total = rects.reduce((s, r) => s + r.w * r.h, 0);

  const particles = new Array(count);
  for (let i = 0; i < count; i++) {
    let pick = rng() * total;
    let chosen = rects[0];
    for (const r of rects) {
      const area = r.w * r.h;
      if (pick <= area) {
        chosen = r;
        break;
      }
      pick -= area;
    }
    particles[i] = {
      x: chosen.x + rng() * chosen.w,
      y: chosen.y + rng() * chosen.h,
      level: chosen.level,
      ho: gaussian(rng) * PF_CONFIG.headingHypothesisSigma,
      ss: 1 + gaussian(rng) * PF_CONFIG.strideHypothesisSigma,
      w: 1 / count,
    };
  }
  return particles;
}

// ---------------------------------------------------------------------------
// Prediction step — dead reckoning
// ---------------------------------------------------------------------------

/**
 * Move every particle by the distance the step counter reported, in the
 * direction the compass reported, each corrected by that particle's own
 * hypothesis about how wrong those two sensors are.
 *
 * Note what is shared and what is not. The MEASUREMENT (`measuredHeading`,
 * `measuredMetres`) is one value, because there is one phone. The CORRECTIONS
 * are per-particle, because the filter does not know the true errors — it
 * carries a population of guesses and lets the map and the Wi-Fi decide which
 * guesses survive.
 *
 * @param {Particle[]} particles
 * @param {number} measuredHeading radians, as reported by the compass
 * @param {number} measuredMetres distance the step counter believes was walked
 * @param {() => number} rng
 * @returns {{particles: Particle[], moved: {from: {x:number,y:number}, to: {x:number,y:number}}[]}}
 */
export function propagate(particles, measuredHeading, measuredMetres, rng) {
  const out = new Array(particles.length);
  const moved = new Array(particles.length);

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const steps = Math.max(1e-6, measuredMetres / 0.72);

    // The compass-error hypothesis random-walks, so the filter can track a bias
    // that changes as the user moves through the building.
    const ho = p.ho + gaussian(rng) * PF_CONFIG.headingHypothesisDrift * Math.sqrt(steps);
    const heading = measuredHeading + ho;
    const travelled = measuredMetres * p.ss;

    const next = {
      x: p.x + Math.cos(heading) * travelled,
      y: p.y + Math.sin(heading) * travelled,
      level: p.level, // a step counter cannot detect a floor change
      ho,
      ss: p.ss,
      w: p.w,
    };
    out[i] = next;
    moved[i] = { from: { x: p.x, y: p.y }, to: { x: next.x, y: next.y } };
  }

  return { particles: out, moved };
}

// ---------------------------------------------------------------------------
// Map matching — the floor plan as evidence, not as a clamp
// ---------------------------------------------------------------------------

/**
 * Kill every particle that is now inside a wall, or that crossed a wall to get
 * where it is.
 *
 * This is where the floor plan does real work. Checking the PATH and not just
 * the destination is what stops a particle teleporting between two corridors
 * through a shop unit. And because a particle's position is the accumulation of
 * its own error hypotheses, deleting the ones that ended up somewhere impossible
 * is implicitly deleting wrong hypotheses about the compass — which is why this
 * corrects drift ALONG a corridor too, not just across it. A simple snap-to-
 * corridor can never do that.
 *
 * @returns {{particles: Particle[], survived: number}}
 */
export function applyMapConstraint(particles, moved, levelsById) {
  const kept = [];

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const level = levelsById.get(p.level);
    if (!level) continue;

    // Must end up somewhere a person can stand.
    if (!pointInAnyRect(p, level.corridors)) continue;

    // ...and must not have walked through a wall to get there.
    if (moved) {
      const m = moved[i];
      if (m && countWallsCrossed(m.from, m.to, level.walls) > 0) continue;
    }

    kept.push(p);
  }

  return { particles: kept, survived: kept.length };
}

/**
 * Regrow the cloud back to full size by resampling from the survivors.
 *
 * Necessary because map matching deletes particles, and a cloud that only ever
 * shrinks eventually collapses to a single point and stops representing
 * uncertainty at all. Small jitter on the copies keeps them from being exact
 * duplicates.
 */
export function replenish(particles, rng, count = PF_CONFIG.count) {
  if (particles.length === 0) return [];
  if (particles.length >= count) return particles.slice(0, count);

  const out = particles.slice();
  while (out.length < count) {
    const src = particles[Math.floor(rng() * particles.length)];
    out.push({
      ...src,
      x: src.x + gaussian(rng) * 0.15,
      y: src.y + gaussian(rng) * 0.15,
      ho: src.ho + gaussian(rng) * 0.01,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Correction step — Wi-Fi fingerprint likelihood
// ---------------------------------------------------------------------------

/**
 * Build a lookup so a particle can find its nearest radio-map reference point
 * cheaply. The reference points sit on a regular grid, so a hash bucketed at the
 * grid spacing plus a search of the neighbouring buckets is enough.
 */
export function buildRadioMapIndex(radioMap) {
  const cell = radioMap.spacing;
  const buckets = new Map();
  radioMap.points.forEach((p, i) => {
    const key = `${p.level}:${Math.round(p.x / cell)}:${Math.round(p.y / cell)}`;
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(i);
  });
  return { buckets, cell };
}

/** Index of the reference point nearest `p`, or -1 if none is close. */
function nearestRef(index, radioMap, p, level) {
  const { buckets, cell } = index;
  const cx = Math.round(p.x / cell);
  const cy = Math.round(p.y / cell);
  let best = -1;
  let bestD = Infinity;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const list = buckets.get(`${level}:${cx + dx}:${cy + dy}`);
      if (!list) continue;
      for (const i of list) {
        const d = dist(radioMap.points[i], p);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  return best;
}

/**
 * Re-weight particles by how well the radio map's prediction at each particle's
 * location matches the signal actually observed.
 *
 * The radio map doubles as the sensor model here: rather than recomputing
 * propagation for every particle, we look up the fingerprint already stored for
 * the nearest reference point. That is both far cheaper and exactly what a real
 * fingerprinting system does — the map IS what it knows about the radio
 * environment.
 *
 * @returns {{particles: Particle[], relocalized: boolean, bestResidualDb: number}}
 */
export function applyWifi(particles, obs, radioMap, index, rng) {
  const m = obs.length;
  const sigma2 = PF_CONFIG.likelihoodSigmaDb ** 2;

  // Score every reference point in the map. We need this twice: to judge whether
  // the cloud is even in the right region, and to rebuild it if it is not.
  const mapScores = scoreRadioMap(obs, radioMap);

  let bestLog = -Infinity;
  let bestResidual = Infinity;
  const logs = new Array(particles.length);

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const ref = nearestRef(index, radioMap, p, p.level);
    if (ref < 0) {
      logs[i] = -Infinity;
      continue;
    }
    // RMS residual per access point — an interpretable "how wrong is this
    // hypothesis, in dB".
    const residual = mapScores.residuals[ref];
    if (residual < bestResidual) bestResidual = residual;

    const log = (-residual * residual * m) / (2 * sigma2) + Math.log(Math.max(p.w, 1e-12));
    logs[i] = log;
    if (log > bestLog) bestLog = log;
  }

  // The likelihood-ratio test. If the best hypothesis in the cloud is materially
  // worse than the best hypothesis anywhere in the building, we are not merely
  // uncertain — we are in the wrong place, and re-weighting cannot fix that.
  const lost =
    !Number.isFinite(bestLog) ||
    bestResidual > mapScores.bestResidual + PF_CONFIG.relocalizeMarginDb;

  if (lost) {
    return {
      // Note we hand the existing cloud over. Being in the wrong PLACE says
      // nothing about whether our estimate of the compass bias was any good —
      // that is a property of the phone, not of position — so the sensor-error
      // hypotheses are carried across rather than reset to the prior.
      particles: relocalizeFrom(mapScores, radioMap, rng, particles),
      relocalized: true,
      bestResidualDb: bestResidual,
      globalBestDb: mapScores.bestResidual,
    };
  }

  // Normalise in the log domain to avoid underflow.
  let sum = 0;
  const out = new Array(particles.length);
  for (let i = 0; i < particles.length; i++) {
    const w = Math.exp(logs[i] - bestLog);
    out[i] = { ...particles[i], w };
    sum += w;
  }
  for (const p of out) p.w /= sum || 1;

  // Resample only when the cloud has become badly unbalanced. Resampling every
  // scan needlessly throws away diversity.
  const ess = 1 / out.reduce((s, p) => s + p.w * p.w, 0);
  const resampled =
    ess < PF_CONFIG.resampleEssRatio * out.length ? systematicResample(out, rng) : out;

  return {
    particles: resampled,
    relocalized: false,
    bestResidualDb: bestResidual,
    globalBestDb: mapScores.bestResidual,
  };
}

/**
 * RMS fingerprint residual, in dB per access point, for every reference point in
 * the radio map. Cheap enough to run on every scan (a few hundred points times
 * fourteen access points) and it gives us the global best explanation to compare
 * the particle cloud against.
 */
function scoreRadioMap(obs, radioMap) {
  const m = obs.length;
  const n = radioMap.points.length;
  const residuals = new Float64Array(n);
  let bestResidual = Infinity;
  let bestIndex = 0;

  for (let i = 0; i < n; i++) {
    const vec = radioMap.vectors[i];
    let ss = 0;
    for (let j = 0; j < m; j++) {
      const d = obs[j] - vec[j];
      ss += d * d;
    }
    const r = Math.sqrt(ss / m);
    residuals[i] = r;
    if (r < bestResidual) {
      bestResidual = r;
      bestIndex = i;
    }
  }
  return { residuals, bestResidual, bestIndex, m };
}

/**
 * Global re-localisation: rebuild the cloud by sampling reference points in
 * proportion to how well each explains the observation.
 *
 * This is the mechanism that recovers a floor change. Dead reckoning cannot feel
 * an escalator, so after the ride every particle is confidently on the wrong
 * level, and re-weighting cannot help because the correct answer has zero
 * probability in the cloud. Detecting that and starting again from the radio map
 * is the honest response, and it is what real systems do.
 */
function relocalizeFrom(mapScores, radioMap, rng, priorParticles = null, count = PF_CONFIG.count) {
  const sigma2 = PF_CONFIG.likelihoodSigmaDb ** 2;
  const { residuals, bestResidual, m } = mapScores;

  // Normalise against the best explanation so the exponentials stay in range.
  const weights = new Float64Array(residuals.length);
  let total = 0;
  for (let i = 0; i < residuals.length; i++) {
    const w = Math.exp(
      -(residuals[i] * residuals[i] * m) / (2 * sigma2) +
        (bestResidual * bestResidual * m) / (2 * sigma2),
    );
    weights[i] = w;
    total += w;
  }
  total = total || 1;

  const particles = new Array(count);
  for (let k = 0; k < count; k++) {
    let pick = rng() * total;
    let idx = 0;
    for (let i = 0; i < weights.length; i++) {
      if (pick <= weights[i]) {
        idx = i;
        break;
      }
      pick -= weights[i];
    }
    const ref = radioMap.points[idx];

    // Carry the sensor-error hypotheses across from the old cloud if we have
    // one. Losing track of WHERE we are is not evidence that our estimate of
    // the compass bias was wrong, and throwing it away makes the filter
    // dead-reckon on an uncalibrated heading immediately after every recovery.
    const donor = priorParticles?.length
      ? priorParticles[Math.floor(rng() * priorParticles.length)]
      : null;

    particles[k] = {
      x: ref.x + gaussian(rng) * (radioMap.spacing / 2),
      y: ref.y + gaussian(rng) * (radioMap.spacing / 2),
      level: ref.level,
      ho: donor ? donor.ho : gaussian(rng) * PF_CONFIG.headingHypothesisSigma,
      ss: donor ? donor.ss : 1 + gaussian(rng) * PF_CONFIG.strideHypothesisSigma,
      w: 1 / count,
    };
  }
  return particles;
}

/**
 * Systematic resampling: one uniform draw, then evenly spaced strides through
 * the cumulative weights. Lower variance than drawing each particle
 * independently, and it is the standard choice.
 */
function systematicResample(particles, rng) {
  const n = particles.length;
  const out = new Array(n);
  const step = 1 / n;
  let u = rng() * step;
  let c = particles[0].w;
  let i = 0;

  for (let k = 0; k < n; k++) {
    while (u > c && i < n - 1) {
      i++;
      c += particles[i].w;
    }
    out[k] = { ...particles[i], w: step };
    u += step;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading an answer out of the cloud
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Floor transitions — map matching in the vertical dimension
// ---------------------------------------------------------------------------

/**
 * Move the cloud up or down a number of floors, using only connectors that
 * could physically have carried each particle there.
 *
 * WHY THIS EXISTS
 * ---------------
 * Without it, the filter only discovers a floor change when a Wi-Fi scan
 * fails to match anything and it gives up and rebuilds the whole cloud from the
 * radio map. That is slow (the next scan can be 30 s away), and it throws away
 * everything the filter had learnt about the compass.
 *
 * When the barometer reports "you went up one floor", the floor plan tells us
 * exactly where that was possible: nobody changes floor in the middle of a
 * corridor. So each particle may only change floor through a connector that
 *
 *   - is within reach of where that particle thinks it is,
 *   - stops on both the floor it is leaving and the floor it is arriving at,
 *   - runs in that direction (an up-escalator cannot take you down), and
 *   - is in service.
 *
 * A particle with no such connector is an impossible hypothesis and is deleted
 * — the vertical equivalent of deleting a particle that walked through a wall.
 * Survivors land AT the connector, so a floor change is also a free position
 * fix: the user must have been standing there. And unlike re-localisation,
 * each particle keeps its compass and stride hypotheses.
 *
 * @param {Particle[]} particles
 * @param {{
 *   deltaFloors: number,          // +1 up one floor, -2 down two, ...
 *   typeHint?: string,            // 'lift' | 'escalator' | 'stairs' from the classifier
 *   connectors: object[],         // CONNECTORS from the floor plan
 *   ordinalByLevel: Map<number, number>,
 *   levelByOrdinal: Map<number, number>,
 *   spreadM: number,              // current cloud spread, sets how far "within reach" is
 * }} event
 * @param {() => number} rng
 * @returns {{ particles: Particle[], survived: number, connectorId: string | null, fallback: boolean }}
 */
export function applyFloorTransition(particles, event, rng) {
  const { deltaFloors, typeHint, connectors, ordinalByLevel, levelByOrdinal, spreadM } = event;
  const goingUp = deltaFloors > 0;

  /** Connectors that could carry someone from `level` by `deltaFloors`. */
  const candidatesFor = (level) => {
    const destLevel = levelByOrdinal.get((ordinalByLevel.get(level) ?? level) + deltaFloors);
    if (destLevel === undefined) return { destLevel, list: [] };
    const list = connectors.filter(
      (c) =>
        c.inService !== false &&
        c.servesLevels.includes(level) &&
        c.servesLevels.includes(destLevel) &&
        (c.direction === 'both' || c.direction === (goingUp ? 'up' : 'down')),
    );
    return { destLevel, list };
  };

  // How far a particle may be from a connector and still plausibly have used
  // it. Tied to the cloud's own spread: a confident cloud must be close; an
  // uncertain one is given the benefit of the doubt.
  const reachM = Math.max(6, 3 * spreadM);
  const sigma = Math.max(3, spreadM);
  // The classifier's guess (lift vs escalator vs stairs) is a soft preference,
  // not a rule — vertical speed and step count are suggestive, not conclusive.
  const typeWeight = (c) => (!typeHint || c.type === typeHint ? 1 : 0.25);

  const moved = [];
  const votes = new Map();
  const cache = new Map();

  for (const p of particles) {
    if (!cache.has(p.level)) cache.set(p.level, candidatesFor(p.level));
    const { destLevel, list } = cache.get(p.level);
    if (!list.length) continue;

    let total = 0;
    const weights = list.map((c) => {
      const d = dist(p, c);
      const w = d > reachM ? 0 : Math.exp(-(d * d) / (2 * sigma * sigma)) * typeWeight(c);
      total += w;
      return w;
    });
    if (total === 0) continue; // nothing within reach: an impossible hypothesis

    let pick = rng() * total;
    let chosen = list[list.length - 1];
    for (let i = 0; i < list.length; i++) {
      pick -= weights[i];
      if (pick <= 0) {
        chosen = list[i];
        break;
      }
    }
    votes.set(chosen.id, (votes.get(chosen.id) ?? 0) + 1);
    moved.push({
      ...p,
      x: chosen.x + gaussian(rng) * 0.6,
      y: chosen.y + gaussian(rng) * 0.6,
      level: destLevel,
    });
  }

  if (moved.length > 0) {
    return {
      particles: moved,
      survived: moved.length,
      connectorId: [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0],
      fallback: false,
    };
  }

  // No particle was near any admissible connector. The barometer is far more
  // trustworthy about "you changed floor" than the cloud is about "you were
  // here", so rather than ignore the floor change, spread the cloud across every
  // connector that could have made it, keeping the sensor hypotheses.
  const summary = summariseParticles(particles);
  const { destLevel, list } = candidatesFor(summary?.level ?? particles[0]?.level);
  if (!list.length) return { particles, survived: 0, connectorId: null, fallback: true };

  // Weighted by distance from the cloud, so the nearest plausible connector
  // dominates; a uniform choice put most of the cloud at connectors 20 m away.
  const centre = summary ?? particles[0];
  const fbWeights = list.map((c) => {
    const d = dist(centre, c);
    return Math.exp(-(d * d) / (2 * 10 * 10)) * typeWeight(c);
  });
  const fbTotal = fbWeights.reduce((a, b) => a + b, 0) || 1;
  const fallbackParticles = particles.map((p) => {
    let pick = rng() * fbTotal;
    let c = list[list.length - 1];
    for (let i = 0; i < list.length; i++) {
      pick -= fbWeights[i];
      if (pick <= 0) {
        c = list[i];
        break;
      }
    }
    return { ...p, x: c.x + gaussian(rng) * 0.6, y: c.y + gaussian(rng) * 0.6, level: destLevel };
  });
  return { particles: fallbackParticles, survived: 0, connectorId: null, fallback: true };
}

/** Cell size for finding the densest cluster in the cloud, in metres. */
const MODE_CELL_M = 2;

/** Particles within this radius of the modal cell count as the same cluster. */
const MODE_RADIUS_M = 3.5;

/**
 * Collapse the cloud to the single position and uncertainty the app displays.
 *
 * Two decisions here matter, and both are about not averaging things that should
 * not be averaged:
 *
 * 1. The FLOOR is a weighted vote, because there is no such place as level 1.5.
 *
 * 2. The POSITION is the centre of the densest cluster, not the mean of the
 *    whole cloud. When the filter is genuinely torn — say half its hypotheses
 *    are in the main concourse and half are in the cross concourse — the mean of
 *    those two groups lands in the shop unit between them, which is a position
 *    the filter positively believes is impossible. Reporting the dominant mode
 *    instead means the answer is always somewhere the filter actually considers
 *    plausible.
 *
 * `spreadM` is deliberately measured over the WHOLE cloud rather than just the
 * reported cluster. That keeps the uncertainty honest: if the filter is torn
 * between two corridors, it should say so with a large radius rather than
 * reporting false precision about the cluster it happened to pick.
 *
 * Note what none of this uses: the true position. A real app has no access to
 * it, so neither does this.
 */
export function summariseParticles(particles) {
  if (!particles || particles.length === 0) return null;

  const totalW = particles.reduce((s, p) => s + p.w, 0) || 1;

  // --- The floor: a weighted vote ---
  const votes = new Map();
  for (const p of particles) votes.set(p.level, (votes.get(p.level) ?? 0) + p.w);
  let level = particles[0].level;
  let bestVote = -Infinity;
  for (const [lvl, v] of votes) {
    if (v > bestVote) {
      bestVote = v;
      level = lvl;
    }
  }

  const onLevel = particles.filter((p) => p.level === level);
  const levelW = onLevel.reduce((s, p) => s + p.w, 0) || 1;

  // --- The position: centre of the heaviest cluster ---
  const cells = new Map();
  for (const p of onLevel) {
    const key = `${Math.floor(p.x / MODE_CELL_M)}:${Math.floor(p.y / MODE_CELL_M)}`;
    cells.set(key, (cells.get(key) ?? 0) + p.w);
  }
  let modalKey = null;
  let modalW = -Infinity;
  for (const [key, w] of cells) {
    if (w > modalW) {
      modalW = w;
      modalKey = key;
    }
  }
  const [cx, cy] = modalKey.split(':').map(Number);
  const seed = { x: (cx + 0.5) * MODE_CELL_M, y: (cy + 0.5) * MODE_CELL_M };

  const cluster = onLevel.filter((p) => dist(p, seed) <= MODE_RADIUS_M);
  const used = cluster.length ? cluster : onLevel;
  const cw = used.reduce((s, p) => s + p.w, 0) || 1;
  const x = used.reduce((s, p) => s + p.x * p.w, 0) / cw;
  const y = used.reduce((s, p) => s + p.y * p.w, 0) / cw;

  // --- The uncertainty: spread of everything on this floor about that point ---
  const variance =
    onLevel.reduce((s, p) => s + p.w * ((p.x - x) ** 2 + (p.y - y) ** 2), 0) / levelW;

  return {
    x,
    y,
    level,
    /** 1-sigma radius of the cloud, in metres. The app's own confidence. */
    spreadM: Math.sqrt(Math.max(0, variance)),
    /** Fraction of the cloud that agrees on the floor. */
    floorConfidence: bestVote / totalW,
    /**
     * Fraction of the on-floor cloud inside the reported cluster. Well below 1
     * means the filter is torn between separate places, not merely fuzzy about
     * one — a materially different kind of uncertainty.
     */
    modeShare: cw / levelW,
    count: particles.length,
  };
}
