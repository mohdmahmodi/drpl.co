/**
 * drpl.co - background canvas
 *
 * The floating particle mesh behind the UI. Neutral dots with faint
 * connecting lines; a small fraction of dots carry the accent orange.
 * Pauses when the tab is hidden and respects reduced-motion.
 */

class BackgroundAnimation {
  constructor() {
    this.canvas = document.getElementById("background-canvas");
    if (!this.canvas) return;

    this.ctx = this.canvas.getContext("2d");
    this.reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    this.running = false;

    this.resize();
    this.initParticles();
    this.updateTheme();

    window.addEventListener("resize", () => {
      this.resize();
      this.initParticles();
      if (this.reducedMotion) this.drawFrame();
    });
    document.addEventListener("theme-changed", () => {
      this.updateTheme();
      if (this.reducedMotion) this.drawFrame();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.running = false;
      } else {
        this.start();
      }
    });

    this.start();
  }

  start() {
    if (this.reducedMotion) {
      // A single static frame; no animation loop
      this.drawFrame();
      return;
    }
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  updateTheme() {
    const dark =
      document.documentElement.getAttribute("data-theme") === "dark";
    // Monochrome constellation. Light mode uses a very dark gray at low
    // alpha so the mesh is actually visible without competing with content.
    this.dotColor = dark
      ? "rgba(250, 250, 250, 0.11)"
      : "rgba(23, 23, 23, 0.14)";
    this.lineColor = dark
      ? "rgba(250, 250, 250, 0.05)"
      : "rgba(23, 23, 23, 0.06)";
  }

  initParticles() {
    const count = Math.min(
      90,
      Math.floor((this.width * this.height) / 16000),
    );
    this.particles = [];
    for (let i = 0; i < count; i++) {
      this.particles.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        radius: Math.random() * 2.2 + 1,
        vx: Math.random() * 0.4 - 0.2,
        vy: Math.random() * 0.4 - 0.2,
      });
    }
  }

  drawFrame() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    const particles = this.particles;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      if (this.running) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > this.width) p.vx = -p.vx;
        if (p.y < 0 || p.y > this.height) p.vy = -p.vy;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = this.dotColor;
      ctx.fill();

      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        if (dx * dx + dy * dy < 150 * 150) {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = this.lineColor;
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }
    }
  }

  loop() {
    if (!this.running) return;
    this.drawFrame();
    requestAnimationFrame(() => this.loop());
  }
}
