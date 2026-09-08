(function(){
  var $ = function(id){ return document.getElementById(id); };
  var pendingBlob = null;
  var keepExistingPhoto = false;
  var editingTicketId = null;
  var deleteTargetId = null;
  var myTickets = [];

  // ---------- thème clair / sombre ----------
  function updateThemeIcon(){
    $("themeToggleBtn").textContent = ttCurrentTheme() === "dark" ? "☀️" : "🌙";
  }
  $("themeToggleBtn").addEventListener("click", ttToggleTheme);
  document.addEventListener("tt-theme-changed", updateThemeIcon);
  updateThemeIcon();

  function readLocal(key, fallback){
    try { return localStorage.getItem(key) || fallback; } catch(e){ return fallback; }
  }
  function writeLocal(key, val){
    try { localStorage.setItem(key, val); } catch(e){}
  }

  var techName = readLocal("tt_tech_name", "");
  $("techName").value = techName;

  $("techName").addEventListener("change", function(){
    techName = $("techName").value.trim();
    writeLocal("tt_tech_name", techName);
    loadMyTickets();
  });

  // ---------- suggestions de noms déjà utilisés ----------
  fetch("/api/technicians")
    .then(function(res){ return res.json(); })
    .then(function(names){
      var list = $("techNameList");
      list.innerHTML = "";
      (names || []).forEach(function(n){
        var opt = document.createElement("option");
        opt.value = n;
        list.appendChild(opt);
      });
    })
    .catch(function(){});

  // ---------- toast ----------
  var toastTimer = null;
  function showToast(msg){
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 3200);
  }

  // ---------- dialogs ----------
  document.querySelectorAll("[data-close]").forEach(function(b){
    b.addEventListener("click", function(){ $(b.dataset.close).close(); });
  });
  $("lightbox").addEventListener("click", function(){ $("lightbox").close(); });

  $("newTicketBtn").addEventListener("click", function(){
    if(!techName){
      $("techName").focus();
      showToast("Indiquez votre nom d'abord");
      return;
    }
    openCreateForm();
  });

  function defaultPhotoLabel(){
    return '<span class="icon">📷</span><span>Prendre / choisir une photo du ticket</span>';
  }

  function openCreateForm(){
    editingTicketId = null;
    $("ticketForm").reset();
    $("dateInput").value = new Date().toISOString().slice(0,10);
    pendingBlob = null;
    keepExistingPhoto = false;
    $("photoPickerContent").innerHTML = defaultPhotoLabel();
    $("submitTicketBtn").disabled = false;
    $("submitTicketBtn").textContent = "Enregistrer";
    document.querySelector("#captureDialog .dialog-head h2").textContent = "Nouveau ticket";
    $("captureDialog").showModal();
  }

  function openEditForm(t){
    editingTicketId = t.id;
    $("ticketForm").reset();
    pendingBlob = null;
    keepExistingPhoto = !!t.photo_url;
    $("montantInput").value = t.montant;
    $("dateInput").value = t.date;
    $("categorieInput").value = t.categorie;
    $("noteInput").value = t.note || "";
    $("pendingReceiptInput").checked = !!t.pending_receipt;
    $("photoPickerContent").innerHTML = t.photo_url
      ? '<img src="' + t.photo_url + '" alt="Photo actuelle">'
      : defaultPhotoLabel();
    $("submitTicketBtn").disabled = false;
    $("submitTicketBtn").textContent = "Enregistrer les modifications";
    document.querySelector("#captureDialog .dialog-head h2").textContent = "Modifier le ticket";
    $("captureDialog").showModal();
  }

  // ---------- photo compression ----------
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

  $("photoInput").addEventListener("change", function(){
    var file = $("photoInput").files[0];
    if(!file) return;
    keepExistingPhoto = false;
    $("photoPickerContent").innerHTML = "<span>Compression de la photo…</span>";
    compressToBlob(file).then(function(blob){
      pendingBlob = blob;
      var url = URL.createObjectURL(blob);
      $("photoPickerContent").innerHTML = '<img src="' + url + '" alt="Aperçu du ticket">';
    }).catch(function(){
      $("photoPickerContent").innerHTML = '<span class="icon">📷</span><span>Échec de lecture — réessayez</span>';
    });
  });

  // ---------- submit (création ou modification) ----------
  $("ticketForm").addEventListener("submit", function(e){
    e.preventDefault();
    var pendingReceipt = $("pendingReceiptInput").checked;
    var hasPhoto = !!pendingBlob || keepExistingPhoto;
    if(!hasPhoto && !pendingReceipt){
      showToast("Ajoutez une photo, ou cochez « justificatif en attente »");
      return;
    }
    var montant = parseFloat($("montantInput").value);
    if(!(montant > 0)){
      showToast("Indiquez un montant valide");
      return;
    }
    var categorie = $("categorieInput").value;
    var date = $("dateInput").value;
    var note = $("noteInput").value.trim();

    var fd = new FormData();
    fd.append("technicien", techName);
    fd.append("montant", montant);
    fd.append("date", date);
    fd.append("categorie", categorie);
    fd.append("note", note);
    fd.append("pending_receipt", pendingReceipt ? "1" : "0");
    if(pendingBlob){
      fd.append("photo", pendingBlob, "ticket.jpg");
    }

    var isEdit = !!editingTicketId;
    var url = isEdit ? "/api/tickets/" + editingTicketId : "/api/tickets";

    $("submitTicketBtn").disabled = true;
    fetch(url, { method: isEdit ? "PUT" : "POST", body: fd })
      .then(function(res){
        if(!res.ok) return res.json().then(function(d){ throw new Error(d.error || "Erreur"); });
        return res.json();
      })
      .then(function(){
        $("captureDialog").close();
        showToast(isEdit ? "Ticket modifié" : "Enregistré — " + categorie + " · " + montant.toFixed(2).replace(".", ",") + " €");
        loadMyTickets();
      })
      .catch(function(err){
        showToast(err.message || "Échec de l'enregistrement");
        $("submitTicketBtn").disabled = false;
      });
  });

  // ---------- suppression ----------
  $("deleteConfirmDialog").addEventListener("click", function(e){ if(e.target === this) this.close(); });
  $("confirmDeleteBtn").addEventListener("click", function(){
    if(!deleteTargetId) return;
    fetch("/api/tickets/" + deleteTargetId + "?technicien=" + encodeURIComponent(techName), { method: "DELETE" })
      .then(function(res){
        if(!res.ok) return res.json().then(function(d){ throw new Error(d.error || "Erreur"); });
        return res.json();
      })
      .then(function(){
        $("deleteConfirmDialog").close();
        showToast("Ticket supprimé");
        loadMyTickets();
      })
      .catch(function(err){
        showToast(err.message || "Échec de la suppression");
      });
  });

  // ---------- formatting ----------
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
      '<span class="ticket-date mono">' + frDate(t.date) + '</span>';
    if(t.pending_receipt && !t.photo_url){
      top.innerHTML += '<span class="pending-badge">' + escapeHtml(t.categorie || "Justificatif") + ' en attente</span>';
    }
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
      an.textContent = "Admin : " + t.admin_note;
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

    if(t.status === "en_attente"){
      var actions = document.createElement("div");
      actions.className = "tech-actions";
      var editBtn = document.createElement("button");
      editBtn.className = "btn-sm"; editBtn.type = "button"; editBtn.textContent = "Modifier";
      editBtn.addEventListener("click", function(){ openEditForm(t); });
      actions.appendChild(editBtn);
      var delBtn = document.createElement("button");
      delBtn.className = "btn-sm bad-btn"; delBtn.type = "button"; delBtn.textContent = "Supprimer";
      delBtn.addEventListener("click", function(){
        deleteTargetId = t.id;
        $("deleteConfirmDialog").showModal();
      });
      actions.appendChild(delBtn);
      card.appendChild(actions);
    }

    return card;
  }

  function statTile(label, value, sub, tone){
    var d = document.createElement("div");
    d.className = "stat-tile" + (tone ? " " + tone : "");
    d.innerHTML = '<div class="label">' + label + '</div><div class="value mono">' + value + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '');
    return d;
  }

  function renderTechView(){
    var enAttente = myTickets.filter(function(t){ return t.status === "en_attente"; });
    var valide = myTickets.filter(function(t){ return t.status === "valide"; });
    var sumEnAttente = enAttente.reduce(function(s,t){ return s + (t.montant||0); }, 0);
    var sumValide = valide.reduce(function(s,t){ return s + (t.montant||0); }, 0);

    $("techSummary").innerHTML = "";
    $("techSummary").appendChild(statTile("Tickets soumis", String(myTickets.length), "", "accent"));
    $("techSummary").appendChild(statTile("En attente", eur(sumEnAttente), enAttente.length + " ticket(s)", "warn"));
    $("techSummary").appendChild(statTile("Validé", eur(sumValide), valide.length + " ticket(s)", "ok"));

    var list = $("techTicketList");
    list.innerHTML = "";
    if(!techName){
      list.innerHTML = '<div class="empty-state">Indiquez votre nom pour voir vos tickets.</div>';
      return;
    }
    if(myTickets.length === 0){
      list.innerHTML = '<div class="empty-state">Aucun ticket pour l\'instant — appuyez sur « Nouveau ticket » pour photographier votre premier justificatif.</div>';
      return;
    }
    myTickets.forEach(function(t){ list.appendChild(ticketCard(t)); });
  }

  function loadMyTickets(){
    if(!techName){ myTickets = []; renderTechView(); return; }
    fetch("/api/tickets?technicien=" + encodeURIComponent(techName))
      .then(function(res){ return res.json(); })
      .then(function(data){ myTickets = data; renderTechView(); })
      .catch(function(){ showToast("Impossible de charger vos tickets"); });
  }

  renderTechView();
  loadMyTickets();
  setInterval(loadMyTickets, 20000);
})();
