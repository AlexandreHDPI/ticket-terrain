(function(){
  try {
    var stored = localStorage.getItem("tt_theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (e) {}
})();

function ttCurrentTheme(){
  var attr = document.documentElement.getAttribute("data-theme");
  if (attr) return attr;
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}

function ttSetTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("tt_theme", theme); } catch (e) {}
  document.dispatchEvent(new CustomEvent("tt-theme-changed", { detail: { theme: theme } }));
}

function ttToggleTheme(){
  ttSetTheme(ttCurrentTheme() === "dark" ? "light" : "dark");
}
