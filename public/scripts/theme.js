/**
 * drpl.co - theme switching
 *
 * The toggle button flips [data-theme] on <html>. The sun/moon icon swap is
 * pure CSS. The pre-CSS inline script in index.html applies the stored (or
 * system) theme before first paint.
 */

class ThemeManager {
  constructor() {
    this.toggle = document.getElementById("theme-toggle");
    if (!this.toggle) return;

    this.toggle.addEventListener("click", () => this.flip());

    // Follow system changes only while the user has no explicit preference
    if (window.matchMedia) {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = (e) => {
        if (localStorage.getItem("theme")) return;
        this.apply(e.matches ? "dark" : "light");
      };
      if (query.addEventListener) query.addEventListener("change", onChange);
      else if (query.addListener) query.addListener(onChange);
    }

    this._syncMetaColor();
  }

  flip() {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    this.apply(next);
    localStorage.setItem("theme", next);
  }

  apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    this._syncMetaColor();
    document.dispatchEvent(
      new CustomEvent("theme-changed", { detail: { theme } }),
    );
  }

  // Keep the browser chrome color in step with the applied theme, which can
  // differ from the OS scheme the media-query metas react to.
  _syncMetaColor() {
    const dark =
      document.documentElement.getAttribute("data-theme") === "dark";
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((meta) => meta.setAttribute("content", dark ? "#1b1b1b" : "#f1f1f1"));
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.themeManager = new ThemeManager();
});
