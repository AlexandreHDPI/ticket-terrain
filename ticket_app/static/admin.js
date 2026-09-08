(function(){
  var $ = function(id){ return document.getElementById(id); };
  var allTickets = [];
  var adminFilterTech = "all";
  var editingAdminTicketId = null;
  var adminPendingBlob = null;
  var adminKeepExistingPhoto = false;

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
    var headers = ["Technicien", "Date", "Catégorie", "Montant (EUR)", "Carte (4 derniers chiffres)", "Statut", "Note", "Motif admin", "Créé le"];
    var lines = [headers.map(csvEscape).join(";")];
    allTickets.forEach(function(t){
      lines.push([
        t.technicien,
        frDate(t.date),
        t.categorie,
        eur(t.montant || 0),
        t.card_last4 || "",
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

    if(t.photo_url){
      var img = document.createElement("img");
      img.className = "thumb";
      img.src = t.photo_url;
      img.alt = "Ticket " + (t.categorie || "");
      img.addEventListener("click", function(){
        $("lightboxImg").src = t.photo_url;
        $("lightbox").showModal();
      });
      card.appendChild(img);
    } else {
      var ph = document.createElement("div");
      ph.className = "thumb-placeholder";
      ph.textContent = "🕒";
      card.appendChild(ph);
    }

    var main = document.createElement("div");
    main.className = "ticket-main";
    var top = document.createElement("div");
    top.className = "ticket-top";
    top.innerHTML =
      '<span class="ticket-cat">' + escapeHtml(t.categorie || "") + '</span>' +
      '<span class="ticket-date mono">' + frDate(t.date) + '</span>' +
      '<span class="ticket-tech">· ' + escapeHtml(t.technicien || "") + '</span>';
    if(t.pending_receipt && !t.photo_url){
      top.innerHTML += '<span class="pending-badge">' + escapeHtml(t.categorie || "Justificatif") + ' en attente</span>';
    }
    if(t.card_last4){
      top.innerHTML += '<span class="card-badge">💳 •••• ' + escapeHtml(t.card_last4) + '</span>';
    }
    main.appendChild(top);
    if(t.lat != null && t.lng != null){
      var locA = document.createElement("a");
      locA.className = "location-badge";
      locA.href = "https://www.openstreetmap.org/?mlat=" + t.lat + "&mlon=" + t.lng + "#map=16/" + t.lat + "/" + t.lng;
      locA.target = "_blank";
      locA.rel = "noopener";
      locA.textContent = "📍 " + (t.location_label || "Voir sur la carte");
      main.appendChild(locA);
    }
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
    var editBtn = document.createElement("button");
    editBtn.className = "btn-sm plain-btn"; editBtn.type = "button"; editBtn.textContent = "Modifier";
    editBtn.addEventListener("click", function(){ openAdminEdit(t); });
    actions.appendChild(editBtn);
    card.appendChild(actions);

    return card;
  }

  // ---------- édition admin (tous statuts, tous champs) ----------
  function adminDefaultPhotoLabel(){
    return '<span class="icon">📷</span><span>Changer la photo du ticket</span>';
  }

  function openAdminEdit(t){
    editingAdminTicketId = t.id;
    adminPendingBlob = null;
    adminKeepExistingPhoto = !!t.photo_url;
    $("adminEditForm").reset();
    $("adminTechInput").value = t.technicien || "";
    $("adminMontantInput").value = t.montant;
    $("adminCardLast4Input").value = t.card_last4 || "";
    $("adminDateInput").value = t.date;
    $("adminCategorieInput").value = t.categorie;
    $("adminNoteInput").value = t.note || "";
    $("adminPendingReceiptInput").checked = !!t.pending_receipt;
    $("adminPhotoPickerContent").innerHTML = t.photo_url
      ? '<img src="' + t.photo_url + '" alt="Photo actuelle">'
      : adminDefaultPhotoLabel();
    $("adminEditDialog").showModal();
  }

  function compressToBlob(file){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function(){
        var img = new Image();
        img.onerror = reject;
        img.onload = function(){
          var dims = [1600, 1280, 1000, 800];
          var qualities = [0.8, 0.65, 0.5, 0.4];
          var targetBytes = 380000;
          var di = 0, qi = 0;
          function tryNext(lastBlob){
            if(di >= dims.length){ resolve(lastBlob); return; }
            var maxDim = dims[di];
            var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            var w = Math.max(1, Math.round(img.width * scale));
            var h = Math.max(1, Math.round(img.height * scale));
            var canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, w, h);
            canvas.toBlob(function(blob){
              if(!blob){ reject(new Error("toBlob failed")); return; }
              if(blob.size <= targetBytes || (di === dims.length - 1 && qi === qualities.length - 1)){
                resolve(blob);
                return;
              }
              qi++;
              if(qi >= qualities.length){ qi = 0; di++; }
              tryNext(blob);
            }, "image/jpeg", qualities[qi]);
          }
          tryNext(null);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  $("adminCardLast4Input").addEventListener("input", function(){
    this.value = this.value.replace(/\D/g, "").slice(0, 4);
  });

  $("adminPhotoInput").addEventListener("change", function(){
    var file = $("adminPhotoInput").files[0];
    if(!file) return;
    adminKeepExistingPhoto = false;
    $("adminPhotoPickerContent").innerHTML = "<span>Compression de la photo…</span>";
    compressToBlob(file).then(function(blob){
      adminPendingBlob = blob;
      var url = URL.createObjectURL(blob);
      $("adminPhotoPickerContent").innerHTML = '<img src="' + url + '" alt="Aperçu">';
    }).catch(function(){
      $("adminPhotoPickerContent").innerHTML = '<span class="icon">📷</span><span>Échec de lecture — réessayez</span>';
    });
  });

  $("adminEditForm").addEventListener("submit", function(e){
    e.preventDefault();
    if(!editingAdminTicketId) return;
    var montant = parseFloat($("adminMontantInput").value);
    if(!(montant > 0)){ showToast("Indiquez un montant valide"); return; }
    var fd = new FormData();
    fd.append("technicien", $("adminTechInput").value.trim());
    fd.append("montant", montant);
    fd.append("date", $("adminDateInput").value);
    fd.append("categorie", $("adminCategorieInput").value);
    fd.append("note", $("adminNoteInput").value.trim());
    fd.append("pending_receipt", $("adminPendingReceiptInput").checked ? "1" : "0");
    var adminCard = $("adminCardLast4Input").value.trim();
    if(adminCard && !/^\d{4}$/.test(adminCard)){
      showToast("Les 4 derniers chiffres de la carte doivent être 4 chiffres");
      return;
    }
    fd.append("card_last4", adminCard);
    if(adminPendingBlob){
      fd.append("photo", adminPendingBlob, "ticket.jpg");
    }
    $("adminSubmitEditBtn").disabled = true;
    fetch("/api/admin/tickets/" + editingAdminTicketId, { method: "PUT", body: fd })
      .then(function(res){
        if(!res.ok) return res.json().then(function(d){ throw new Error(d.error || "Erreur"); });
        return res.json();
      })
      .then(function(){
        $("adminEditDialog").close();
        showToast("Ticket modifié");
        loadTickets();
      })
      .catch(function(err){ showToast(err.message || "Échec de l'enregistrement"); })
      .finally(function(){ $("adminSubmitEditBtn").disabled = false; });
  });

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
    var dateFrom = $("dateFromFilter").value;
    var dateTo = $("dateToFilter").value;
    var filtered = allTickets.filter(function(t){
      var techOk = adminFilterTech === "all" || (t.technicien || "?").trim().toLowerCase() === adminFilterTech;
      var statusOk = statusFilter === "all" || t.status === statusFilter;
      var dateOk = (!dateFrom || (t.date || "") >= dateFrom) && (!dateTo || (t.date || "") <= dateTo);
      return techOk && statusOk && dateOk;
    });

    var list = $("adminTicketList");
    list.innerHTML = "";
    if(filtered.length === 0){
      list.innerHTML = '<div class="empty-state">Aucun ticket ne correspond à ce filtre.</div>';
    } else {
      filtered.forEach(function(t){ list.appendChild(ticketCard(t)); });
    }

    if($("techView").style.display !== "none"){
      renderTechGrid();
    }
  }

  // ---------- bascule vue globale / par technicien ----------
  $("viewGlobalBtn").addEventListener("click", function(){
    $("viewGlobalBtn").classList.add("active");
    $("viewTechBtn").classList.remove("active");
    $("globalView").style.display = "";
    $("techView").style.display = "none";
  });
  $("viewTechBtn").addEventListener("click", function(){
    $("viewTechBtn").classList.add("active");
    $("viewGlobalBtn").classList.remove("active");
    $("techView").style.display = "";
    $("globalView").style.display = "none";
    renderTechGrid();
  });

  function techSummaries(){
    var byTech = {};
    allTickets.forEach(function(t){
      var key = (t.technicien || "?").trim().toLowerCase();
      if(!byTech[key]){
        byTech[key] = { key: key, label: (t.technicien || "?").trim(), count: 0, sumEnAttente: 0, sumValide: 0, sumRejete: 0, total: 0 };
      }
      var s = byTech[key];
      s.count++;
      s.total += (t.montant || 0);
      if(t.status === "en_attente") s.sumEnAttente += (t.montant || 0);
      else if(t.status === "valide") s.sumValide += (t.montant || 0);
      else if(t.status === "rejete") s.sumRejete += (t.montant || 0);
    });
    return Object.keys(byTech).map(function(k){ return byTech[k]; }).sort(function(a,b){ return b.count - a.count; });
  }

  function renderTechGrid(){
    var grid = $("techGrid");
    grid.innerHTML = "";
    var summaries = techSummaries();
    if(summaries.length === 0){
      grid.innerHTML = '<div class="empty-state">Aucun ticket enregistré pour l\'instant.</div>';
      return;
    }
    summaries.forEach(function(s){
      var card = document.createElement("button");
      card.type = "button";
      card.className = "tech-card";
      card.innerHTML =
        '<div class="tech-name">' + escapeHtml(s.label) + '</div>' +
        '<div class="tech-metrics">' +
          '<div>' + s.count + ' ticket(s) · <b>' + eur(s.total) + '</b> au total</div>' +
          '<div>En attente : <b>' + eur(s.sumEnAttente) + '</b></div>' +
          '<div>Validé : <b>' + eur(s.sumValide) + '</b></div>' +
        '</div>';
      card.addEventListener("click", function(){ openTechDetail(s.key, s.label); });
      grid.appendChild(card);
    });
  }

  function openTechDetail(key, label){
    var tickets = allTickets.filter(function(t){ return (t.technicien || "?").trim().toLowerCase() === key; });
    $("techDetailName").textContent = label;

    var enAttente = tickets.filter(function(t){ return t.status === "en_attente"; });
    var valide = tickets.filter(function(t){ return t.status === "valide"; });
    var rejete = tickets.filter(function(t){ return t.status === "rejete"; });
    var stats = $("techDetailStats");
    stats.innerHTML = "";
    stats.appendChild(statTile("Tickets", String(tickets.length), "", "accent"));
    stats.appendChild(statTile("En attente", eur(enAttente.reduce(function(s,t){return s+(t.montant||0);},0)), enAttente.length + " ticket(s)", "warn"));
    stats.appendChild(statTile("Validé", eur(valide.reduce(function(s,t){return s+(t.montant||0);},0)), valide.length + " ticket(s)", "ok"));
    stats.appendChild(statTile("Rejeté", String(rejete.length), "ticket(s)", "bad"));

    var byMonth = {};
    tickets.forEach(function(t){
      var m = (t.date || "").slice(0,7);
      if(!m) return;
      byMonth[m] = (byMonth[m] || 0) + (t.montant || 0);
    });
    var months = Object.keys(byMonth).sort().slice(-6);
    var maxVal = Math.max.apply(null, months.map(function(m){ return byMonth[m]; }).concat([0.01]));
    var barsEl = $("techMonthBars");
    barsEl.innerHTML = "";
    if(months.length === 0){
      barsEl.innerHTML = '<div class="empty-state">Pas encore de données.</div>';
    } else {
      months.forEach(function(m){
        var row = document.createElement("div");
        row.className = "month-bar-row";
        var pct = Math.max(4, Math.round((byMonth[m] / maxVal) * 100));
        row.innerHTML =
          '<span class="month-label">' + monthLabel(m) + '</span>' +
          '<span class="month-bar-track"><span class="month-bar-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="month-value">' + eur(byMonth[m]) + '</span>';
        barsEl.appendChild(row);
      });
    }

    var list = $("techDetailList");
    list.innerHTML = "";
    tickets.forEach(function(t){ list.appendChild(ticketCard(t)); });

    $("techDetailDialog").showModal();
  }

  function monthLabel(m){
    var parts = m.split("-");
    var names = ["Jan","Fév","Mar","Avr","Mai","Juin","Juil","Août","Sep","Oct","Nov","Déc"];
    var idx = parseInt(parts[1], 10) - 1;
    return (names[idx] || m) + " " + parts[0];
  }

  $("statusFilter").addEventListener("change", render);
  $("dateFromFilter").addEventListener("change", render);
  $("dateToFilter").addEventListener("change", render);
  $("clearDateFilter").addEventListener("click", function(){
    $("dateFromFilter").value = "";
    $("dateToFilter").value = "";
    render();
  });

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
