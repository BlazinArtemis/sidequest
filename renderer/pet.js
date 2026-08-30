// renderer/pet.js
// The idle pets: small creatures that wander the screen when the machine has
// been idle, and open the game if you click them.
//
// They are drawn into the same canvas and driven by the same RAF loop as the
// games, because it IS the same window — just resized and made transparent.
//
// Exposed as window.SQPets = { snake, robot, pacman }.
//
// Everything is drawn with a heavy dark outline. These float directly over
// whatever is on the desktop — a bright document, a dark editor, a photo — so
// flat fills with no stroke vanish against half the backgrounds they land on.

(function (root) {
  const SPEED = 30;           // px per second
  const TURN_RATE = 2.2;      // radians per second towards the target heading
  const OUTLINE = 'rgba(5, 8, 14, 0.78)';
  const OUTLINE_W = 2.5;

  // Shared wander behaviour: pick a heading now and then, ease towards it, and
  // turn away from the edges before arriving at them.
  class Wanderer {
    constructor(scale = 1) {
      this.scale = scale;
      this.reset();
    }

    reset() {
      this.x = 0;
      this.y = 0;
      this.heading = Math.random() * Math.PI * 2;
      this.targetHeading = this.heading;
      this.sinceTurn = 0;
      this.age = 0;
      this.seeded = false;
    }

    // Bounds work in drawn pixels, so they have to account for the scale and
    // for the outline width — clamping to the raw radius let the stroke hang
    // over the window edge and get clipped mid-turn.
    hitRadius() { return this.radius() * this.scale + OUTLINE_W; }

    tick(dt, w, h) {
      if (!this.seeded) {
        this.x = w / 2;
        this.y = h / 2;
        this.seeded = true;
        this.onSeed();
      }

      const secs = dt / 1000;
      this.age += dt;

      this.sinceTurn += dt;
      if (this.sinceTurn > 700 + Math.random() * 900) {
        this.sinceTurn = 0;
        this.targetHeading = this.heading + (Math.random() - 0.5) * 2.4;
      }

      // Start turning well before the edge. A snake's body trails behind the
      // head along the path it took, so turning late is what swings the tail
      // outside the window and clips it.
      const margin = this.hitRadius() + 26;
      if (this.x < margin) this.targetHeading = 0;
      else if (this.x > w - margin) this.targetHeading = Math.PI;
      if (this.y < margin) this.targetHeading = Math.PI / 2;
      else if (this.y > h - margin) this.targetHeading = -Math.PI / 2;

      // Rotate the short way round towards the target.
      let delta = this.targetHeading - this.heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.heading += Math.max(-TURN_RATE * secs, Math.min(TURN_RATE * secs, delta));

      this.x += Math.cos(this.heading) * SPEED * secs;
      this.y += Math.sin(this.heading) * SPEED * secs;
      const r = this.hitRadius();
      this.x = Math.max(r, Math.min(w - r, this.x));
      this.y = Math.max(r, Math.min(h - r, this.y));

      this.step(dt);
    }

    render(ctx, w, h) {
      ctx.clearRect(0, 0, w, h);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // Scale about the creature's own position so x/y stay world coordinates
      // and the hit-testing in overlay.js keeps working unchanged.
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.scale(this.scale, this.scale);
      ctx.translate(-this.x, -this.y);
      this.draw(ctx);
      ctx.restore();
    }

    // Filled shape with the standard heavy outline.
    blob(ctx, fn, fill) {
      ctx.beginPath();
      fn();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = OUTLINE_W;
      ctx.strokeStyle = OUTLINE;
      ctx.stroke();
    }

    onSeed() {}
    step() {}
    radius() { return 14; }
    draw() {}
  }

  // ---- snake ------------------------------------------------------------
  class SnakePet extends Wanderer {
    reset() {
      super.reset();
      this.trail = Array.from({ length: 9 }, () => ({ x: 0, y: 0 }));
      this.blink = 0;
      this.nextBlink = 1200 + Math.random() * 2600;
    }

    onSeed() { this.trail.forEach((p) => { p.x = this.x; p.y = this.y; }); }
    radius() { return 12; }

    step(dt) {
      // Each joint chases the one ahead, holding a fixed spacing.
      let px = this.x;
      let py = this.y;
      for (const seg of this.trail) {
        const dx = px - seg.x;
        const dy = py - seg.y;
        const dist = Math.hypot(dx, dy) || 1;
        if (dist > 11) {
          seg.x += (dx / dist) * (dist - 11);
          seg.y += (dy / dist) * (dist - 11);
        }
        px = seg.x;
        py = seg.y;
      }

      this.blink += dt;
      if (this.blink > this.nextBlink) {
        this.blink = 0;
        this.nextBlink = 1200 + Math.random() * 2600;
      }
    }

    draw(ctx) {
      for (let i = this.trail.length - 1; i >= 0; i--) {
        const seg = this.trail[i];
        const t = 1 - i / this.trail.length;
        this.blob(ctx, () => ctx.arc(seg.x, seg.y, 4.5 + 4 * t, 0, Math.PI * 2), '#34d399');
      }
      this.blob(ctx, () => ctx.arc(this.x, this.y, 12, 0, Math.PI * 2), '#a7f3d0');

      const blinking = this.blink < 110;
      const nx = Math.cos(this.heading);
      const ny = Math.sin(this.heading);
      for (const side of [-1, 1]) {
        const ex = this.x + nx * 4 + -ny * 4.6 * side;
        const ey = this.y + ny * 4 + nx * 4.6 * side;
        ctx.fillStyle = '#0b1220';
        if (blinking) {
          ctx.fillRect(ex - 2.6, ey - 0.7, 5.2, 1.5);
        } else {
          ctx.beginPath();
          ctx.arc(ex, ey, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // ---- pacman -----------------------------------------------------------
  class PacmanPet extends Wanderer {
    reset() {
      super.reset();
      this.chomp = 0;
    }

    radius() { return 20; }
    step(dt) { this.chomp += dt; }

    draw(ctx) {
      // Mouth opens and shuts on a sine, wide enough to read at a glance.
      const open = (0.30 + 0.30 * Math.abs(Math.sin(this.chomp / 130))) * Math.PI;
      const r = 20;
      this.blob(ctx, () => {
        ctx.moveTo(this.x, this.y);
        ctx.arc(this.x, this.y, r, this.heading + open / 2, this.heading - open / 2 + Math.PI * 2);
        ctx.closePath();
      }, '#facc15');

      // Eye sits above the mouth axis, on whichever side is "up" for its heading.
      const nx = Math.cos(this.heading);
      const ny = Math.sin(this.heading);
      const ex = this.x + nx * 1 + -ny * 8.5;
      const ey = this.y + ny * 1 + nx * 8.5;
      ctx.beginPath();
      ctx.fillStyle = '#0b1220';
      ctx.arc(ex, ey, 2.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- robot ------------------------------------------------------------
  class RobotPet extends Wanderer {
    reset() {
      super.reset();
      this.bob = 0;
    }

    radius() { return 24; }
    step(dt) { this.bob += dt; }

    draw(ctx) {
      // Robots do not bank into turns; it stays upright and bobs as it walks.
      const lift = Math.sin(this.bob / 150) * 2.6;
      const x = this.x;
      const y = this.y + lift;
      const facing = Math.cos(this.heading) >= 0 ? 1 : -1;

      // Legs, alternating.
      const swing = Math.sin(this.bob / 150) * 4;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.lineWidth = 5.5;
        ctx.strokeStyle = OUTLINE;
        ctx.moveTo(x + side * 7, y + 15);
        ctx.lineTo(x + side * 7 + swing * side, y + 25);
        ctx.stroke();
      }

      // Antenna.
      ctx.beginPath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = OUTLINE;
      ctx.moveTo(x, y - 17);
      ctx.lineTo(x + facing * 6, y - 27);
      ctx.stroke();
      this.blob(ctx, () => ctx.arc(x + facing * 6, y - 27, 4.5, 0, Math.PI * 2), '#f87171');

      // Body.
      this.blob(ctx, () => ctx.roundRect(x - 18, y - 17, 36, 33, 9), '#93c5fd');

      // Visor, shifted the way it is heading.
      this.blob(ctx, () => ctx.roundRect(x - 11 + facing * 3, y - 9, 22, 14, 5), '#0b1220');
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.fillStyle = '#5eead4';
        ctx.arc(x + facing * 3 + side * 5, y - 2, 2.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  root.SQPets = { snake: SnakePet, pacman: PacmanPet, robot: RobotPet };

  // Draw one avatar, centred and still, for the settings picker. A list of
  // words makes you guess what you are choosing; showing the creature does not.
  root.SQPetPreview = function renderPreview(ctx, box, name) {
    const Ctor = root.SQPets[name];
    if (!Ctor) return;

    const pet = new Ctor();
    pet.seeded = true;
    pet.heading = 0;
    pet.x = 0;
    pet.y = 0;
    // Fixed poses: a preview that animates or faces a random way is noise.
    if (pet.trail) {
      pet.trail = pet.trail.slice(0, 4);
      pet.trail.forEach((s, i) => { s.x = -(i + 1) * 11; s.y = 0; });
    }
    if (pet.chomp !== undefined) pet.chomp = 205;  // mouth part-open
    if (pet.bob !== undefined) pet.bob = 0;

    // Snakes extend backwards from the head, so shift them right to sit centred.
    const nudge = pet.trail ? (pet.trail.length * 11) / 2 : 0;
    const extent = pet.trail ? pet.trail.length * 11 + 30 : pet.radius() * 2.6;

    ctx.save();
    ctx.clearRect(0, 0, box, box);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.translate(box / 2, box / 2);
    ctx.scale((box * 0.92) / extent, (box * 0.92) / extent);
    ctx.translate(nudge, 0);
    pet.draw(ctx);
    ctx.restore();
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SnakePet, PacmanPet, RobotPet };
  }
})(typeof window !== 'undefined' ? window : globalThis);
