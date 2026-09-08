(function(){
  var $ = function(id){ return document.getElementById(id); };
  var allTickets = [];
  var adminFilterTech = "all";

  var toastTimer = null;
  function showToast(msg){
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 3200);
  }

  $("lightbox").addEventListener("click", function(){ $("lightbox").close(); });

  // ---------- réglages : thème + export ----------
  document.querySelectorAll("[data-close]").forEach(function(b){
    b.addEventListener("click", function(){ $(b.dataset.close).close(); });
  });

  function updateThemeUI(){
    var theme = ttCurrentTheme();
    $("themeToggleBtn").textContent = theme === "dark" ? "☀️" : "🌙";
    $("themeLightBtn").classList.toggle("active", theme === "light");
    $("themeDarkBtn").classList.toggle("active", theme === "dark");
  }
  $("themeToggleBtn").addEventListener("click", ttToggleTheme);
  $("themeLightBtn").addEventListener("click", function(){ ttSetTheme("light"); });
  $("themeDarkBtn").addEventListener("click", function(){ ttSetTheme("dark"); });
  document.addEventListener("tt-theme-changed", updateThemeUI);
  updateThemeUI();

  $("settingsBtn").addEventListener("click", function(){ $("settingsDialog").showModal(); });

  function csvEscape(v){
    v = (v === undefined || v === null) ? "" : String(v);
    if (/[;"\n]/.test(v)) { v = '"' + v.replace(/"/g, '""') + '"'; }
    return v;
  }

  function exportCsv(){
    var headers = ["Technicien", "Date", "Catégorie", "Montant (EUR)", "Statut", "Note", "Motif admin", "Créé le"];
    var lines = [headers.map(csvEscape).join(";")];
    allTickets.forEach(function(t){
      lines.push([
        t.technicien,
        frDate(t.date),
        t.categorie,
        eur(t.montant || 0),
        STATUS_LABEL[t.status] || t.status,
        t.note || "",
        t.admin_note || "",
        t.created_at || ""
      ].map(csvEscape).join(";"));
    });
    var csv = "﻿" + lines.join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "tickets-terrain-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }
  $("exportBtn").addEventListener("click", exportCsv);

  function eur(n){ return (Math.round(n*100)/100).toFixed(2).replace(".", ",") + " €"; }
  function frDate(iso){
    if(!iso) return "";
    var p = iso.split("-");
    if(p.length !== 3) return iso;
    return p[2] + "/" + p[1] + "/" + p[0];
  }
  var STATUS_LABEL = { en_attente:"En attente", valide:"Validé", rejete:"Rejeté" };

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }

  function statTile(label, value, sub, tone){
    var d = document.createElement("div");
    d.className = "stat-tile" + (tone ? " " + tone : "");
    d.innerHTML = '<div class="label">' + label + '</div><div class="value mono">' + value + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '');
    return d;
  }

  function updateStatus(id, status, adminNote){
    fetch("/api/admin/tickets/" + id + "/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: status, admin_note: adminNote || "" })
    }).then(function(res){
      if(!res.ok) throw new Error();
      return loadTickets();
    }).catch(function(){ showToast("Échec de la mise à jour"); });
  }

  function openRejectRow(card, id){
    if(card.querySelector(".reject-row")) return;
    var row = document.createElement("div");
    row.className = "reject-row";
    var input = document.createElement("input");
    input.placeholder = "Motif du rejet (optionnel)";
    var confirmBtn = document.createElement("button");
    confirmBtn.className = "btn-sm bad-btn"; confirmBtn.type = "button"; confirmBtn.textContent = "Confirmer";
    confirmBtn.addEventListener("click", function(){ updateStatus(id, "rejete", input.value.trim()); });
    var cancelBtn = document.createElement("button");
    cancelBtn.className = "btn-sm plain-btn"; cancelBtn.type = "button"; cancelBtn.textContent = "Annuler";
    cancelBtn.addEventListener("click", function(){ row.remove(); });
    row.appendChild(input); row.appendChild(confirmBtn); row.appendChild(cancelBtn);
    card.appendChild(row);
  }

  function ticketCard(t){
    var card = document.createElement("div");
    card.className = "ticket-card";

    var img = document.createElement("img");
    img.className = "thumb";
    img.src = t.photo_url || "";
    img.alt = "Ticket " + (t.categorie || "");
    img.addEventListener("click", function(){
      $("lightboxImg").src = t.photo_url || "";
      $("lightbox").showModal();
    });
    card.appendChild(img);

    var main = document.createElement("div");
    main.className = "ticket-main";
    var top = document.createElement("div");
    top.className = "ticket-top";
    top.innerHTML =
      '<span class="ticket-cat">' + escapeHtml(t.categorie || "") + '</span>' +
      '<span class="ticket-date mono">' + frDate(t.date) + '</span>' +
      '<span class="ticket-tech">· ' + escapeHtml(t.technicien || "") + '</span>';
    main.appendChild(top);
    if(t.note){
      var note = document.createElement("div");
      note.className = "ticket-note";
      note.textContent = t.note;
      main.appendChild(note);
    }
    if(t.status !== "en_attente" && t.admin_note){
      var an = document.createElement("div");
      an.className = "ticket-note";
      an.textContent = "Votre motif : " + t.admin_note;
      main.appendChild(an);
    }
    card.appendChild(main);

    var side = document.createElement("div");
    side.className = "ticket-side";
    var amt = document.createElement("div");
    amt.className = "ticket-amount mono";
    amt.textContent = eur(t.montant || 0);
    side.appendChild(amt);
    var pill = document.createElement("span");
    pill.className = "pill " + t.status;
    pill.textContent = STATUS_LABEL[t.status] || t.status;
    side.appendChild(pill);
    card.appendChild(side);

    var actions = document.createElement("div");
    actions.className = "admin-actions";
    actions.style.gridColumn = "1/-1";
    if(t.status !== "valide"){
      var okBtn = document.createElement("button");
      okBtn.className = "btn-sm ok-btn"; okBtn.type = "button"; okBtn.textContent = "Valider";
      okBtn.addEventListener("click", function(){ updateStatus(t.id, "valide", ""); });
      actions.appendChild(okBtn);
    }
    if(t.status !== "rejete"){
      var badBtn = document.createElement("button");
      badBtn.className = "btn-sm bad-btn"; badBtn.type = "button"; badBtn.textContent = "Rejeter";
      badBtn.addEventListener("click", function(){ openRejectRow(card, t.id); });
      actions.appendChild(badBtn);
    }
    if(t.status !== "en_attente"){
      var resetBtn = document.createElement("button");
      resetBtn.className = "btn-sm plain-btn"; resetBtn.type = "button"; resetBtn.textContent = "Remettre en attente";
      resetBtn.addEventListener("click", function(){ updateStatus(t.id, "en_attente", ""); });
      actions.appendChild(resetBtn);
    }
    card.appendChild(actions);

    return card;
  }

  function render(){
    var enAttente = allTickets.filter(function(t){ return t.status === "en_attente"; });
    var valide = allTickets.filter(function(t){ return t.status === "valide"; });
    var rejete = allTickets.filter(function(t){ return t.status === "rejete"; });
    var sumEnAttente = enAttente.reduce(function(s,t){ return s + (t.montant||0); }, 0);
    var sumValide = valide.reduce(function(s,t){ return s + (t.montant||0); }, 0);

    $("adminStats").innerHTML = "";
    $("adminStats").appendChild(statTile("En attente", eur(sumEnAttente), enAttente.length + " ticket(s)", "warn"));
    $("adminStats").appendChild(statTile("Validé", eur(sumValide), valide.length + " ticket(s)", "ok"));
    $("adminStats").appendChild(statTile("Rejeté", String(rejete.length), "ticket(s)", "bad"));
    $("adminStats").appendChild(statTile("Total tickets", String(allTickets.length), "", "accent"));

    var byTech = {};
    allTickets.forEach(function(t){
      var key = (t.technicien || "?").trim().toLowerCase();
      if(!byTech[key]) byTech[key] = { label: (t.technicien || "?").trim(), count: 0 };
      byTech[key].count++;
    });
    var chipRow = $("techChips");
    chipRow.innerHTML = "";
    var allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "chip" + (adminFilterTech === "all" ? " active" : "");
    allChip.textContent = "Tous (" + allTickets.length + ")";
    allChip.addEventListener("click", function(){ adminFilterTech = "all"; render(); });
    chipRow.appendChild(allChip);
    Object.keys(byTech).sort(function(a,b){ return byTech[b].count - byTech[a].count; }).forEach(function(key){
      var c = document.createElement("button");
      c.type = "button";
      c.className = "chip" + (adminFilterTech === key ? " active" : "");
      c.textContent = byTech[key].label + " (" + byTech[key].count + ")";
      c.addEventListener("click", function(){ adminFilterTech = key; render(); });
      chipRow.appendChild(c);
    });

    var statusFilter = $("statusFilter").value;
    var filtered = allTickets.filter(function(t){
      var techOk = adminFilterTech === "all" || (t.technicien || "?").trim().toLowerCase() === adminFilterTech;
      var statusOk = statusFilter === "all" || t.status === statusFilter;
      return techOk && statusOk;
    });

    var list = $("adminTicketList");
    list.innerHTML = "";
    if(filtered.length === 0){
      list.innerHTML = '<div class="empty-state">Aucun ticket ne correspond à ce filtre.</div>';
      return;
    }
    filtered.forEach(function(t){ list.appendChild(ticketCard(t)); });
  }

  $("statusFilter").addEventListener("change", render);

  function loadTickets(){
    return fetch("/api/admin/tickets")
      .then(function(res){
        if(res.status === 401){ window.location.href = "/admin/login"; return null; }
        return res.json();
      })
      .then(function(data){
        if(data === null) return;
        allTickets = data;
        render();
      })
      .catch(function(){ showToast("Impossible de charger les tickets"); });
  }

  loadTickets();
  setInterval(loadTickets, 15000);
})();
